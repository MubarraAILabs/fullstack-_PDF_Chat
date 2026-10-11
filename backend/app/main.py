import os
import uuid
from io import BytesIO
from typing import List, Dict, Any

import fitz
import faiss
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google import genai
from sentence_transformers import SentenceTransformer

load_dotenv()

MAX_FILE_BYTES = 25 * 1024 * 1024
CHUNK_SIZE = 1100
CHUNK_OVERLAP = 180
TOP_K = 6

app = FastAPI(title="Multi-PDF Chat API", version="1.0.0")
origin = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin, "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Session-only storage: restarting the API clears all documents and vectors.
documents: Dict[str, Dict[str, Any]] = {}
chunks: List[Dict[str, Any]] = []
faiss_index = None
embedding_model = None
gemini_client = None


class ChatRequest(BaseModel):
    question: str


def get_embedding_model():
    global embedding_model
    if embedding_model is None:
        embedding_model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    return embedding_model


def get_gemini_client():
    global gemini_client
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY is missing. Set it in backend/.env and restart the server.")
    if gemini_client is None:
        gemini_client = genai.Client(api_key=key)
    return gemini_client


def split_text(text: str):
    text = " ".join(text.split())
    if not text:
        return []
    result = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        result.append(text[start:end])
        if end == len(text):
            break
        start = max(0, end - CHUNK_OVERLAP)
    return result


def rebuild_index():
    global faiss_index
    if not chunks:
        faiss_index = None
        return
    vectors = get_embedding_model().encode(
        [item["text"] for item in chunks],
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    ).astype("float32")
    faiss_index = faiss.IndexFlatIP(vectors.shape[1])
    faiss_index.add(vectors)


@app.get("/api/health")
def health():
    return {"status": "ok", "documents": len(documents), "chunks": len(chunks)}


@app.get("/api/documents")
def list_documents():
    return [
        {"id": doc_id, "filename": doc["filename"], "pages": doc["pages"], "chunks": doc["chunks"]}
        for doc_id, doc in documents.items()
    ]


@app.post("/api/documents")
async def upload_documents(files: List[UploadFile] = File(...)):
    if not files:
        raise HTTPException(status_code=400, detail="Choose at least one PDF.")

    added = []
    global chunks
    for file in files:
        filename = file.filename or "uploaded.pdf"
        if not filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail=f"{filename}: only PDF files are supported.")
        raw = await file.read()
        if len(raw) > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail=f"{filename}: exceeds the 25 MB per-file limit.")
        if not raw:
            raise HTTPException(status_code=400, detail=f"{filename}: file is empty.")

        try:
            pdf = fitz.open(stream=BytesIO(raw), filetype="pdf")
            page_texts = [(i + 1, page.get_text("text").strip()) for i, page in enumerate(pdf)]
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"{filename}: could not read this PDF ({exc}).")

        doc_id = str(uuid.uuid4())
        new_chunks = []
        for page_num, page_text in page_texts:
            for part_num, piece in enumerate(split_text(page_text)):
                new_chunks.append({
                    "document_id": doc_id,
                    "filename": filename,
                    "page": page_num,
                    "part": part_num,
                    "text": piece,
                })

        if not new_chunks:
            raise HTTPException(
                status_code=400,
                detail=f"{filename}: no selectable text found. If it is a scanned PDF, run OCR first.",
            )

        documents[doc_id] = {"filename": filename, "pages": len(page_texts), "chunks": len(new_chunks)}
        chunks.extend(new_chunks)
        added.append({"id": doc_id, "filename": filename, "pages": len(page_texts), "chunks": len(new_chunks)})

    rebuild_index()
    return {"uploaded": added, "total_documents": len(documents), "total_chunks": len(chunks)}


@app.delete("/api/documents/{document_id}")
def delete_document(document_id: str):
    global chunks
    if document_id not in documents:
        raise HTTPException(status_code=404, detail="Document not found.")
    del documents[document_id]
    chunks = [chunk for chunk in chunks if chunk["document_id"] != document_id]
    rebuild_index()
    return {"deleted": document_id, "total_documents": len(documents)}


@app.post("/api/chat")
def chat(request: ChatRequest):
    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Enter a question.")
    if not chunks or faiss_index is None:
        raise HTTPException(status_code=400, detail="Upload at least one PDF before asking a question.")

    query_vector = get_embedding_model().encode(
        [question], normalize_embeddings=True, convert_to_numpy=True
    ).astype("float32")
    k = min(TOP_K, len(chunks))
    scores, indices = faiss_index.search(query_vector, k)

    context_parts = []
    sources = []
    seen_sources = set()
    for score, idx in zip(scores[0], indices[0]):
        if idx < 0:
            continue
        item = chunks[int(idx)]
        context_parts.append(
            f"[Source: {item['filename']}, page {item['page']}]\n{item['text']}"
        )
        source_key = (item["document_id"], item["page"])
        if source_key not in seen_sources:
            seen_sources.add(source_key)
            sources.append({"filename": item["filename"], "page": item["page"]})

    prompt = f"""You answer questions using only the provided PDF excerpts.
If the excerpts do not contain enough information, say so clearly.
Do not invent facts. Cite supporting excerpts inline using [filename, page N].

PDF EXCERPTS:
{chr(10).join(context_parts)}

USER QUESTION:
{question}
"""
    try:
        response = get_gemini_client().models.generate_content(
            model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            contents=prompt,
        )
        answer = response.text or "I couldn't generate an answer from the retrieved excerpts."
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Gemini request failed: {exc}")

    return {"answer": answer, "sources": sources}
