import React from "react";

import { useEffect, useRef, useState } from "react";
import { Bot, FileText, Upload, Send, Trash2, Sparkles, PanelLeftClose, Plus, LoaderCircle, MessageSquareText, BookOpen, CheckCircle2, AlertCircle } from "lucide-react";

const API = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

export default function App() {
  const [docs, setDocs] = useState([]);
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hi! Upload one or more PDFs, and I’ll help you find answers across them with page-level sources.", sources: [] }
  ]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState(null);
  const fileInput = useRef(null);
  const endRef = useRef(null);

  useEffect(() => { loadDocs(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  async function loadDocs() {
    try {
      const response = await fetch(`${API}/api/documents`);
      if (response.ok) setDocs(await response.json());
    } catch { /* Backend may not be running yet. */ }
  }

  async function uploadFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    setUploading(true); setNotice(null);
    const form = new FormData();
    files.forEach(file => form.append("files", file));
    try {
      const response = await fetch(`${API}/api/documents`, { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Upload failed.");
      await loadDocs();
      setNotice({ type: "success", text: `Added ${data.uploaded.length} PDF${data.uploaded.length === 1 ? "" : "s"}. Ready to chat.` });
      setMessages(prev => [...prev, { role: "assistant", content: `I've indexed ${data.uploaded.map(d => d.filename).join(", ")}. Ask a question about any of your ${data.total_documents} uploaded document${data.total_documents === 1 ? "" : "s"}.`, sources: [] }]);
    } catch (error) {
      setNotice({ type: "error", text: error.message || "Could not connect to the API. Is the backend running?" });
    } finally { setUploading(false); }
  }

  async function removeDoc(doc) {
    try {
      const response = await fetch(`${API}/api/documents/${doc.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Could not remove document.");
      await loadDocs();
      setNotice({ type: "success", text: `Removed ${doc.filename}.` });
    } catch (error) { setNotice({ type: "error", text: error.message }); }
  }

  async function sendMessage(event) {
    event?.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    if (!docs.length) {
      setNotice({ type: "error", text: "Upload a PDF first, then ask your question." });
      return;
    }
    setQuestion("");
    setMessages(prev => [...prev, { role: "user", content: text, sources: [] }]);
    setBusy(true); setNotice(null);
    try {
      const response = await fetch(`${API}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to answer right now.");
      setMessages(prev => [...prev, { role: "assistant", content: data.answer, sources: data.sources || [] }]);
    } catch (error) {
      setMessages(prev => [...prev, { role: "assistant", content: `I couldn't complete that request: ${error.message}`, sources: [] }]);
    } finally { setBusy(false); }
  }

  function newChat() {
    setMessages([{ role: "assistant", content: "New conversation started. Your uploaded PDFs remain available—what would you like to know?", sources: [] }]);
    setNotice(null);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-icon"><BookOpen size={20}/></div><div><strong>papertrail<span> AI</span></strong><small>YOUR DOCUMENT COPILOT</small></div></div>
        <button className="new-chat" onClick={newChat}><Plus size={17}/> New conversation <span>⌘ K</span></button>
        <div className="sidebar-label"><span>YOUR LIBRARY</span><span>{docs.length}</span></div>
        <div className="document-list">
          {docs.map(doc => <div className="document-item" key={doc.id}>
            <div className="pdf-icon"><FileText size={17}/></div>
            <div className="doc-meta"><strong title={doc.filename}>{doc.filename}</strong><small>{doc.pages} pages · {doc.chunks} sections</small></div>
            <button className="icon-button delete-doc" title="Remove PDF" onClick={() => removeDoc(doc)}><Trash2 size={15}/></button>
          </div>)}
          {!docs.length && <div className="empty-library"><div className="empty-file"><FileText size={21}/></div><p>Your library is empty</p><span>Add PDFs to get started.</span></div>}
        </div>
        <div className="sidebar-bottom">
          <div className="privacy-note"><div className="privacy-dot"/><div><strong>Private workspace</strong><small>Files stay in this running session</small></div></div>
          <div className="user-profile"><div className="avatar">P</div><div><strong>Personal workspace</strong><small>AI document assistant</small></div><PanelLeftClose size={17} className="profile-end"/></div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar"><div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>Document chat</strong></div><div className="top-actions"><div className="model-pill"><span className="model-dot"/> Gemini powered</div><button className="upload-top" onClick={() => fileInput.current?.click()} disabled={uploading}><Upload size={16}/>{uploading ? "Indexing..." : "Add PDFs"}</button></div></header>
        <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={uploadFiles}/>
        <section className="chat-layout">
          <div className="welcome-row"><div className="welcome-icon"><Sparkles size={19}/></div><div><h1>Your documents, understood.</h1><p>Ask questions. Connect the dots. Get answers grounded in your PDFs.</p></div></div>
          {notice && <div className={`notice ${notice.type}`}><span>{notice.type === "success" ? <CheckCircle2 size={16}/> : <AlertCircle size={16}/>}</span>{notice.text}<button onClick={() => setNotice(null)}>×</button></div>}
          <div className="messages">
            {messages.map((message, i) => <div className={`message-row ${message.role}`} key={i}>
              <div className={`message-avatar ${message.role}`}>{message.role === "assistant" ? <Bot size={18}/> : "Y"}</div>
              <div className="message-content"><div className="message-author">{message.role === "assistant" ? "Papertrail AI" : "You"}<span>{message.role === "assistant" ? "· AI assistant" : "· You"}</span></div><div className="message-text">{message.content}</div>
                {message.sources?.length > 0 && <div className="sources"><div className="sources-title"><BookOpen size={14}/> SOURCES</div><div className="source-list">{message.sources.map((source, j) => <span className="source-chip" key={`${source.filename}-${source.page}-${j}`}><FileText size={13}/>{source.filename}<b>p. {source.page}</b></span>)}</div></div>}
              </div>
            </div>)}
            {busy && <div className="message-row assistant"><div className="message-avatar assistant"><Bot size={18}/></div><div className="message-content"><div className="message-author">Papertrail AI <span>· searching your documents</span></div><div className="typing"><LoaderCircle size={16}/> Reading relevant passages<span className="typing-dots">•••</span></div></div></div>}
            <div ref={endRef}/>
          </div>
          {!docs.length && <div className="getting-started"><div className="get-started-icon"><Upload size={20}/></div><div><strong>Start with your first PDF</strong><p>Upload research papers, reports, manuals, or notes. You can add more documents anytime.</p></div><button onClick={() => fileInput.current?.click()}>Choose files <span>→</span></button></div>}
          <div className="composer-wrap"><form className="composer" onSubmit={sendMessage}><textarea value={question} onChange={e => setQuestion(e.target.value)} placeholder={docs.length ? "Ask anything about your documents..." : "Upload a PDF to start asking questions..."} rows={1} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}/><div className="composer-footer"><div className="composer-hint"><MessageSquareText size={14}/><span>Answers are grounded in your uploaded PDFs</span><span className="hint-separator">·</span><span>↵ to send</span></div><button className="send-button" type="submit" disabled={!question.trim() || busy}><Send size={16}/></button></div></form><div className="disclaimer">AI can make mistakes. Verify important information against the original document.</div></div>
        </section>
      </main>
    </div>
  );
}
