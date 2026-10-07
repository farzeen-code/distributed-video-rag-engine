"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://fastapi-rag-pipeline-v5si.onrender.com";

interface UploadedFile {
  name: string;
  wordCount: number;
  mode: string;
  type?: "document" | "video";
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: string[];
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoStep, setVideoStep] = useState("");
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSessionId("session_" + Math.random().toString(36).substring(2, 9));
  }, []);

  // Silently ping backend on page load to wake up the container
  // before the user picks a file and tries to upload
  useEffect(() => {
    fetch(`${API_URL}/`).catch(() => {});
  }, []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [serverError, setServerError] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [uploadRetryCountdown, setUploadRetryCountdown] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uploadRetryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingQuestion = useRef<string>("");
  const pendingUploadFile = useRef<File | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleUpload = async (selectedFile: File, attempt = 1) => {
    // Clear any pending timers
    if (uploadRetryTimerRef.current) {
      clearInterval(uploadRetryTimerRef.current);
      uploadRetryTimerRef.current = null;
    }
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
    setUploadRetryCountdown(0);
    setIsUploading(true);
    setVideoProgress(0);
    setVideoStep("");

    const isVideo = /\.(mp4|mkv|mov|avi|webm)$/i.test(selectedFile.name);

    // ── VIDEO ASYNC UPLOAD & POLLING PIPELINE ──
    if (isVideo) {
      setUploadStatus("Uploading video to server...");
      setVideoProgress(10);
      setVideoStep("Uploading video stream...");

      const formData = new FormData();
      formData.append("file", selectedFile);

      try {
        const res = await fetch(`${API_URL}/upload-video`, {
          method: "POST",
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.detail || "Video upload failed");
        }

        const taskId = data.task_id;
        setUploadStatus("Processing video in background...");

        // Poll Celery task status every 2 seconds
        pollingTimerRef.current = setInterval(async () => {
          try {
            const pollRes = await fetch(`${API_URL}/tasks/${taskId}`);
            const pollData = await pollRes.json();

            if (pollData.state === "PROCESSING") {
              setVideoProgress(pollData.progress || 25);
              setVideoStep(pollData.step || "Processing...");
              setUploadStatus(`${pollData.step || "Processing..."} (${pollData.progress || 0}%)`);
            } else if (pollData.state === "SUCCESS") {
              if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
              setVideoProgress(100);
              setVideoStep("Ready");
              setUploadedFile({
                name: selectedFile.name,
                wordCount: pollData.result?.total_segments || 0,
                mode: "video",
                type: "video",
              });
              setUploadStatus("Video transcribed & indexed successfully!");
              setTimeout(() => {
                setUploadStatus("");
                setVideoProgress(0);
                setVideoStep("");
              }, 3000);
              setIsUploading(false);
              setSidebarOpen(false);
            } else if (pollData.state === "FAILURE") {
              if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
              setUploadStatus(`Error: ${pollData.error || "Video processing failed"}`);
              setIsUploading(false);
            }
          } catch (pollErr) {
            console.error("Task polling error:", pollErr);
          }
        }, 2000);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Video upload failed";
        setUploadStatus(`Error: ${msg}`);
        setIsUploading(false);
      }
      return;
    }

    // ── DOCUMENT SYNCHRONOUS UPLOAD PIPELINE ──
    setUploadStatus(attempt > 1 ? `Retrying upload (attempt ${attempt})...` : "Uploading & indexing document...");

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const res = await fetch(`${API_URL}/upload`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setUploadedFile({
          name: selectedFile.name,
          wordCount: data.word_count,
          mode: data.mode,
          type: "document",
        });
        setUploadStatus("Document indexed successfully!");
        setTimeout(() => setUploadStatus(""), 3000);
        setSidebarOpen(false);
      } else {
        setUploadStatus(`Error: ${data.detail || "Upload failed"}`);
      }
    } catch {
      if (attempt >= 2) {
        setUploadStatus("Server unavailable. Please verify container is running.");
        return;
      }
      pendingUploadFile.current = selectedFile;
      let secs = 70;
      setUploadRetryCountdown(secs);
      setUploadStatus(`Server waking up… retrying in ${secs}s`);

      uploadRetryTimerRef.current = setInterval(() => {
        secs -= 1;
        setUploadRetryCountdown(secs);
        setUploadStatus(`Server waking up… retrying in ${secs}s`);
        if (secs <= 0) {
          clearInterval(uploadRetryTimerRef.current!);
          uploadRetryTimerRef.current = null;
          setUploadRetryCountdown(0);
          handleUpload(selectedFile, attempt + 1);
        }
      }, 1000);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async () => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
    setVideoProgress(0);
    setVideoStep("");

    if (!uploadedFile) return;
    try {
      await fetch(`${API_URL}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: uploadedFile.name }),
      });
    } catch {
      // silent fail
    }
    setUploadedFile(null);
    setFile(null);
    setUploadStatus("");
  };

  const askAttempt = useRef(0);

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || isAsking) return;

    // Clear any existing retry timer
    if (retryTimerRef.current) {
      clearInterval(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    askAttempt.current += 1;
    const currentAttempt = askAttempt.current;

    const userText = question;
    setQuestion("");
    setServerError(false);
    setRetryCountdown(0);
    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setIsAsking(true);

    try {
      const res = await fetch(`${API_URL}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          question: userText,
          filename: uploadedFile?.name || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Backend error");
      }
      askAttempt.current = 0;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer,
          sources: data.sources,
        },
      ]);
    } catch (err: unknown) {
      const isNetwork = err instanceof TypeError;
      if (isNetwork) {
        setMessages((prev) => prev.slice(0, -1));
        pendingQuestion.current = userText;

        if (currentAttempt >= 2) {
          // Gave up — show final error, restore question
          setServerError(false);
          askAttempt.current = 0;
          setQuestion(userText);
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: "⚠️ Server is unavailable after retrying. Please check SnapDeploy and try again manually.",
            },
          ]);
          return;
        }

        setServerError(true);
        // Start 70-second countdown then auto-retry once
        let secs = 70;
        setRetryCountdown(secs);
        retryTimerRef.current = setInterval(() => {
          secs -= 1;
          setRetryCountdown(secs);
          if (secs <= 0) {
            clearInterval(retryTimerRef.current!);
            retryTimerRef.current = null;
            setServerError(false);
            setRetryCountdown(0);
            setQuestion(pendingQuestion.current);
            setTimeout(() => {
              document.getElementById("chat-form")?.dispatchEvent(
                new Event("submit", { cancelable: true, bubbles: true })
              );
            }, 100);
          }
        }, 1000);
      } else {
        askAttempt.current = 0;
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Something went wrong. Please try again.",
          },
        ]);
      }
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <div className="h-screen flex bg-gray-50 overflow-hidden relative">

      {/* ── Mobile Overlay ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ── */}
      <aside
        className={`
          fixed top-0 left-0 h-full z-30 w-72 bg-gray-900 text-white flex flex-col shrink-0
          transform transition-transform duration-300 ease-in-out
          md:relative md:translate-x-0 md:w-64 md:z-auto
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Logo */}
        <div className="p-5 border-b border-gray-800 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold flex items-center gap-2">
              <span className="text-2xl">📄</span> DocAI
            </h1>
            <p className="text-xs text-gray-500 mt-1">AI Document Assistant</p>
          </div>
          {/* Close button (mobile only) */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            aria-label="Close sidebar"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Upload */}
        <div className="p-4 border-b border-gray-800">
          <label className="w-full cursor-pointer">
            <input
              type="file"
              accept=".pdf,.docx,.txt,.mp4,.mkv,.mov,.avi,.webm"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFile(f);
                  setUploadStatus("");
                  handleUpload(f);
                }
              }}
            />
            <div className="flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-lg text-sm font-medium transition-colors min-h-[44px]">
              {isUploading ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Processing...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  Upload Doc or Video
                </>
              )}
            </div>
          </label>

          {file && !uploadedFile && (
            <p className="text-xs text-gray-400 mt-2 text-center truncate px-1">
              {file.name}
            </p>
          )}

          {/* Video Real-Time Progress Bar */}
          {videoProgress > 0 && (
            <div className="mt-2.5 px-0.5">
              <div className="flex justify-between items-center text-[11px] text-gray-400 mb-1">
                <span className="truncate pr-1 font-medium text-blue-300">{videoStep}</span>
                <span className="font-mono text-gray-300">{videoProgress}%</span>
              </div>
              <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-300 rounded-full"
                  style={{ width: `${videoProgress}%` }}
                />
              </div>
            </div>
          )}

          {uploadStatus && (
            <div className="mt-2">
              <p className={`text-xs text-center ${
                uploadStatus.includes("Error") ? "text-red-400" :
                uploadStatus.includes("waking") ? "text-amber-400" :
                "text-green-400"
              }`}>
                {uploadStatus}
              </p>
              {uploadRetryCountdown > 0 && (
                <div className="mt-1.5 h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-amber-400 transition-all duration-1000"
                    style={{ width: `${((45 - uploadRetryCountdown) / 45) * 100}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Loaded Document / Video */}
        {uploadedFile && (
          <div className="p-4 border-b border-gray-800">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-2 font-medium flex items-center justify-between">
              <span>{uploadedFile.type === "video" ? "Loaded Video" : "Loaded Document"}</span>
              <span className="text-[10px] bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded">
                {uploadedFile.type === "video" ? "VIDEO RAG" : "DOC RAG"}
              </span>
            </p>
            <div className="bg-gray-800 rounded-lg p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{uploadedFile.name}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {uploadedFile.type === "video"
                      ? `${uploadedFile.wordCount} segments · Timestamp Indexed`
                      : `${uploadedFile.wordCount.toLocaleString()} words · ${uploadedFile.mode === "full-context" ? "Full context" : "RAG"}`}
                  </p>
                </div>
                <button
                  onClick={handleDelete}
                  className="text-gray-500 hover:text-red-400 transition-colors shrink-0 p-2 rounded hover:bg-gray-700 min-w-[36px] min-h-[36px] flex items-center justify-center"
                  title="Remove document"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Session Info */}
        <div className="mt-auto p-4 border-t border-gray-800">
          <p className="text-xs text-gray-600 mb-1">Session</p>
          <p className="text-xs text-gray-400 font-mono truncate">{sessionId}</p>
        </div>
      </aside>

      {/* ── Main Chat ── */}
      <main className="flex-1 flex flex-col min-w-0 h-full">

        {/* Mobile Header */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors min-w-[40px] min-h-[40px] flex items-center justify-center"
            aria-label="Open sidebar"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg">📄</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 leading-none">DocAI</p>
              {uploadedFile && (
                <p className="text-xs text-gray-400 truncate mt-0.5">{uploadedFile.name}</p>
              )}
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center px-4">
                <div className="text-5xl mb-4">💬</div>
                <h2 className="text-xl font-semibold text-gray-800 mb-1">
                  Ask anything about your document
                </h2>
                <p className="text-sm text-gray-400">
                  {uploadedFile
                    ? `Ready to answer questions about ${uploadedFile.name}`
                    : "Tap the menu to upload a document, then ask a question"}
                </p>
              </div>
            </div>
          ) : (
            messages.map((msg, index) => (
              <div key={index}>
                <ChatMessage message={msg} />
                {msg.role === "assistant" &&
                  msg.sources &&
                  msg.sources.length > 0 && (
                    <SourcesPanel sources={msg.sources} />
                  )}
              </div>
            ))
          )}

          {/* Typing indicator */}
          {isAsking && (
            <div className="flex gap-3 max-w-3xl">
              <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                <span className="text-sm">🤖</span>
              </div>
              <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Server restart error banner */}
        {serverError && (
          <div className="mx-3 md:mx-4 mb-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
            <span className="text-amber-500 text-lg shrink-0">⚠️</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-amber-800">Server is waking up…</p>
              <p className="text-xs text-amber-600 mt-0.5">
                The backend was sleeping. Retrying automatically in{" "}
                <span className="font-bold">{retryCountdown}s</span> — no action needed.
              </p>
              {/* Progress bar */}
              <div className="mt-2 h-1 bg-amber-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-400 transition-all duration-1000"
                  style={{ width: `${((45 - retryCountdown) / 45) * 100}%` }}
                />
              </div>
            </div>
            <button
              onClick={() => {
                if (retryTimerRef.current) clearInterval(retryTimerRef.current);
                setServerError(false);
                setRetryCountdown(0);
                setQuestion(pendingQuestion.current);
              }}
              className="shrink-0 text-amber-400 hover:text-amber-600 p-1 text-xs"
              title="Cancel and edit question"
            >
              ✕
            </button>
          </div>
        )}

        {/* Input */}
        <div className="p-3 md:p-4 border-t border-gray-200 bg-white shrink-0">
          <form id="chat-form" onSubmit={handleAsk} className="max-w-3xl mx-auto flex gap-2 md:gap-3">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                uploadedFile
                  ? `Ask about ${uploadedFile.name}...`
                  : "Upload a document first..."
              }
              disabled={isAsking}
              className="flex-1 border border-gray-300 rounded-xl px-4 py-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400 placeholder:text-gray-400 min-h-[48px]"
            />
            <button
              type="submit"
              disabled={isAsking || !question.trim() || !uploadedFile}
              className="bg-blue-600 text-white px-4 md:px-6 py-3 rounded-xl text-sm font-medium hover:bg-blue-700 active:bg-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2 min-h-[48px] min-w-[48px] justify-center shrink-0"
            >
              {isAsking ? (
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <>
                  <span className="hidden md:inline">Send</span>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </>
              )}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

/* ── Chat Message ── */
function ChatMessage({ message }: { message: Message }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-2 md:gap-3 ${isUser ? "ml-auto flex-row-reverse" : ""} max-w-[90%] md:max-w-3xl`}>
      {/* Avatar */}
      <div className="w-7 h-7 md:w-8 md:h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
        <span className="text-xs md:text-sm">{isUser ? "👤" : "🤖"}</span>
      </div>

      {/* Bubble */}
      <div
        className={`px-3 py-2.5 md:px-4 md:py-3 rounded-2xl text-sm leading-relaxed ${
          isUser
            ? "bg-blue-600 text-white rounded-tr-sm"
            : "bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm"
        }`}
      >
        {isUser ? (
          <p>{message.content}</p>
        ) : (
          <div className="prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-li:my-0">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Sources (below assistant messages) ── */
function SourcesPanel({ sources }: { sources: string[] }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="ml-9 md:ml-11 mt-1">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="text-xs text-gray-400 hover:text-gray-600 transition-colors py-1 px-1"
      >
        {isOpen ? "▾" : "▸"} {sources.length} source chunks
      </button>
      {isOpen && (
        <div className="mt-2 space-y-2">
          {sources.map((src, idx) => (
            <div
              key={idx}
              className="bg-gray-100 rounded-lg p-3 text-xs text-gray-600 border border-gray-200"
            >
              <span className="font-semibold text-gray-500">Chunk {idx + 1}</span>
              <p className="mt-1 leading-relaxed">{src}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
