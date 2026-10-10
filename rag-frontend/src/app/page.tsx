"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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
  const [videoBlobUrl, setVideoBlobUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoStep, setVideoStep] = useState("");
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSessionId("session_" + Math.random().toString(36).substring(2, 9));
  }, []);

  // Ping backend on load
  useEffect(() => {
    fetch(`${API_URL}/`).catch(() => {});
  }, []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [serverError, setServerError] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingQuestion = useRef<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Jump and play video at specific second
  const handleSeek = (seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = seconds;
      videoRef.current.play().catch(() => {});
    }
  };

  const handleUpload = async (selectedFile: File) => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
    setIsUploading(true);
    setVideoProgress(0);
    setVideoStep("");

    const isVideo = /\.(mp4|mkv|mov|avi|webm)$/i.test(selectedFile.name);

    // Create local blob preview URL for video scrubbing
    if (isVideo) {
      const blobUrl = URL.createObjectURL(selectedFile);
      setVideoBlobUrl(blobUrl);
    } else {
      setVideoBlobUrl(null);
    }

    const formData = new FormData();
    formData.append("file", selectedFile);

    // ── VIDEO PIPELINE ──
    if (isVideo) {
      setUploadStatus("Uploading video stream...");
      setVideoProgress(15);
      setVideoStep("Extracting audio with FFmpeg");

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
        setUploadStatus("Transcribing & indexing...");

        pollingTimerRef.current = setInterval(async () => {
          try {
            const pollRes = await fetch(`${API_URL}/tasks/${taskId}`);
            const pollData = await pollRes.json();

            if (pollData.state === "PROCESSING") {
              setVideoProgress(pollData.progress || 30);
              setVideoStep(pollData.step || "Processing video...");
              setUploadStatus(`${pollData.step || "Processing..."}`);
            } else if (pollData.state === "SUCCESS") {
              if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
              setVideoProgress(100);
              setVideoStep("Completed");
              setUploadedFile({
                name: selectedFile.name,
                wordCount: pollData.result?.total_segments || 0,
                mode: "video",
                type: "video",
              });
              setUploadStatus("Video transcribed & indexed!");
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
            console.error("Polling error:", pollErr);
          }
        }, 2000);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Video upload failed";
        setUploadStatus(`Error: ${msg}`);
        setIsUploading(false);
      }
      return;
    }

    // ── DOCUMENT PIPELINE ──
    setUploadStatus("Uploading & indexing document...");

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
      setUploadStatus("Error: Could not connect to backend");
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
    if (videoBlobUrl) {
      URL.revokeObjectURL(videoBlobUrl);
      setVideoBlobUrl(null);
    }

    if (!uploadedFile) return;
    try {
      await fetch(`${API_URL}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: uploadedFile.name }),
      });
    } catch {
      // silent
    }
    setUploadedFile(null);
    setFile(null);
    setUploadStatus("");
  };

  const handleAsk = async (textToSend?: string) => {
    const queryText = (textToSend || question).trim();
    if (!queryText || isAsking) return;

    setQuestion("");
    setServerError(false);
    setRetryCountdown(0);
    setMessages((prev) => [...prev, { role: "user", content: queryText }]);
    setIsAsking(true);

    try {
      const res = await fetch(`${API_URL}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          question: queryText,
          filename: uploadedFile?.name || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Backend error");
      }
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
        setServerError(true);
        let secs = 30;
        setRetryCountdown(secs);
        retryTimerRef.current = setInterval(() => {
          secs -= 1;
          setRetryCountdown(secs);
          if (secs <= 0) {
            clearInterval(retryTimerRef.current!);
            setServerError(false);
          }
        }, 1000);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "⚠️ Unable to get a response. Please check backend connection.",
          },
        ]);
      }
    } finally {
      setIsAsking(false);
    }
  };

  const quickPrompts = [
    "📋 Give me a full summary of all points",
    "⏱️ What are the key moments and advice?",
    "💡 What are the core takeaways?",
  ];

  return (
    <div className="h-screen flex bg-zinc-950 text-zinc-100 overflow-hidden font-sans selection:bg-indigo-500/30 selection:text-indigo-200">

      {/* ── Mobile Overlay ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-30 md:hidden transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sleek Sidebar ── */}
      <aside
        className={`
          fixed top-0 left-0 h-full z-40 w-80 bg-zinc-900/90 backdrop-blur-xl border-r border-zinc-800/80
          flex flex-col shrink-0 transition-transform duration-300 ease-out
          md:relative md:translate-x-0 md:w-72 md:z-auto
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Brand Header */}
        <div className="p-5 border-b border-zinc-800/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-cyan-400 p-0.5 shadow-lg shadow-indigo-500/20">
              <div className="w-full h-full bg-zinc-950 rounded-[10px] flex items-center justify-center">
                <span className="text-base font-bold bg-gradient-to-r from-indigo-300 to-cyan-300 bg-clip-text text-transparent">
                  ⚡
                </span>
              </div>
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-white flex items-center gap-1.5">
                Nexus RAG
                <span className="text-[10px] bg-indigo-500/10 text-indigo-400 font-mono px-1.5 py-0.5 rounded border border-indigo-500/20">
                  v2.0
                </span>
              </h1>
              <p className="text-[11px] text-zinc-400">Multimodal Video & Doc Intelligence</p>
            </div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>

        {/* Upload Zone */}
        <div className="p-4 border-b border-zinc-800/80">
          <label className="w-full block group cursor-pointer">
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
            <div className="relative overflow-hidden rounded-xl bg-gradient-to-b from-zinc-800 to-zinc-900 p-3.5 border border-zinc-700/60 hover:border-indigo-500/50 transition-all duration-200 group-hover:shadow-lg group-hover:shadow-indigo-500/10">
              <div className="flex items-center justify-center gap-2.5 text-xs font-semibold text-zinc-200 group-hover:text-white">
                {isUploading ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-indigo-400" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>Ingesting Media...</span>
                  </>
                ) : (
                  <>
                    <span className="text-base">📁</span>
                    <span>Upload Video or Document</span>
                  </>
                )}
              </div>
            </div>
          </label>

          {/* Glowing Animated Progress Bar */}
          {videoProgress > 0 && (
            <div className="mt-3 bg-zinc-950/60 border border-zinc-800 p-2.5 rounded-xl">
              <div className="flex justify-between items-center text-[11px] mb-1.5">
                <span className="text-indigo-400 font-medium truncate max-w-[180px] flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-ping"></span>
                  {videoStep}
                </span>
                <span className="font-mono text-zinc-300 font-semibold">{videoProgress}%</span>
              </div>
              <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-cyan-400 transition-all duration-300 rounded-full shadow-sm shadow-indigo-500/50"
                  style={{ width: `${videoProgress}%` }}
                />
              </div>
            </div>
          )}

          {uploadStatus && !videoProgress && (
            <p className={`text-xs text-center mt-2.5 font-medium ${
              uploadStatus.includes("Error") ? "text-rose-400" : "text-emerald-400"
            }`}>
              {uploadStatus}
            </p>
          )}
        </div>

        {/* Loaded Document / Video Card */}
        {uploadedFile && (
          <div className="p-4 border-b border-zinc-800/80">
            <div className="flex items-center justify-between text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">
              <span>Active Source</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                uploadedFile.type === "video"
                  ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                  : "bg-blue-500/20 text-blue-300 border border-blue-500/30"
              }`}>
                {uploadedFile.type === "video" ? "🎬 VIDEO" : "📄 DOC"}
              </span>
            </div>
            <div className="bg-zinc-800/60 border border-zinc-700/60 rounded-xl p-3 flex items-start justify-between gap-2.5 shadow-sm">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-zinc-100 truncate">{uploadedFile.name}</p>
                <p className="text-[11px] text-zinc-400 mt-0.5 font-mono">
                  {uploadedFile.type === "video"
                    ? `${uploadedFile.wordCount} chunks · Timestamps active`
                    : `${uploadedFile.wordCount.toLocaleString()} words · Indexed`}
                </p>
              </div>
              <button
                onClick={handleDelete}
                className="text-zinc-500 hover:text-rose-400 p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
                title="Remove source"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Quick System Info Footer */}
        <div className="mt-auto p-4 border-t border-zinc-800/80 bg-zinc-950/40">
          <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-1">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              Celery + Redis
            </span>
            <span className="font-mono text-zinc-400">{sessionId.slice(0, 11)}</span>
          </div>
        </div>
      </aside>

      {/* ── Main Chat & Intelligence Canvas ── */}
      <main className="flex-1 flex flex-col min-w-0 h-full bg-zinc-950">

        {/* Top Navbar */}
        <header className="px-5 py-3.5 border-b border-zinc-800/80 bg-zinc-900/50 backdrop-blur-md flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800"
            >
              ☰
            </button>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-200">
                  {uploadedFile ? uploadedFile.name : "Interactive Knowledge Workspace"}
                </span>
                {uploadedFile && (
                  <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.2 rounded-full font-medium">
                    Ready to Query
                  </span>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* Message Area & Video Panel */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5 max-w-4xl w-full mx-auto">

          {/* Embedded Video Player Panel (Shows when a video is loaded) */}
          {videoBlobUrl && (
            <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-2xl p-3.5 shadow-2xl">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-xs font-semibold text-zinc-300 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
                  Interactive Video Player
                </span>
                <span className="text-[11px] text-zinc-400">Click any timestamp in answers to scrub video</span>
              </div>
              <video
                ref={videoRef}
                src={videoBlobUrl}
                controls
                className="w-full max-h-64 rounded-xl bg-black object-contain border border-zinc-800/80 shadow-inner"
              />
            </div>
          )}

          {/* Empty State */}
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[50vh] text-center px-4">
              <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-3xl mb-4 shadow-xl">
                ⚡
              </div>
              <h2 className="text-lg font-bold text-zinc-100 mb-1">
                {uploadedFile ? `Chat with ${uploadedFile.name}` : "Upload a Video or Document to Begin"}
              </h2>
              <p className="text-xs text-zinc-400 max-w-md leading-relaxed mb-6">
                Ask deep factual questions or request complete summaries. Spoken video points are cited with scrubbable timestamps.
              </p>

              {/* Quick Action Pills */}
              {uploadedFile && (
                <div className="flex flex-wrap gap-2 justify-center max-w-xl">
                  {quickPrompts.map((prompt, i) => (
                    <button
                      key={i}
                      onClick={() => handleAsk(prompt)}
                      className="text-xs bg-zinc-900 hover:bg-zinc-800/80 border border-zinc-800 hover:border-indigo-500/40 text-zinc-300 hover:text-white px-3.5 py-2 rounded-xl transition-all duration-200 cursor-pointer shadow-sm"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            messages.map((msg, idx) => (
              <div key={idx} className="space-y-2">
                <ChatMessage message={msg} onSeek={handleSeek} />
                {msg.role === "assistant" && msg.sources && msg.sources.length > 0 && (
                  <SourcesPanel sources={msg.sources} onSeek={handleSeek} />
                )}
              </div>
            ))
          )}

          {/* Typing Indicator */}
          {isAsking && (
            <div className="flex gap-3 items-center text-xs text-indigo-400 bg-zinc-900/60 border border-zinc-800/60 w-fit px-4 py-2.5 rounded-full">
              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
              Synthesizing response with Gemini...
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Chat Input Bar */}
        <div className="p-4 border-t border-zinc-800/80 bg-zinc-900/60 backdrop-blur-md shrink-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAsk();
            }}
            className="max-w-4xl mx-auto flex gap-2.5"
          >
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                uploadedFile
                  ? `Ask about ${uploadedFile.name}...`
                  : "Upload a video or document to start..."
              }
              disabled={isAsking}
              className="flex-1 bg-zinc-950 border border-zinc-800 focus:border-indigo-500 rounded-xl px-4 py-3 text-xs md:text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none transition-colors"
            />
            <button
              type="submit"
              disabled={isAsking || !question.trim() || !uploadedFile}
              className="px-5 py-3 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-xs md:text-sm font-semibold text-white transition-all shadow-md shadow-indigo-600/20 shrink-0 cursor-pointer"
            >
              {isAsking ? "..." : "Send"}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

/* ── Chat Message with Clickable Timestamps ── */
function ChatMessage({
  message,
  onSeek,
}: {
  message: Message;
  onSeek: (seconds: number) => void;
}) {
  const isUser = message.role === "user";

  const parseTimestampToSeconds = (ts: string): number => {
    const match = ts.match(/(\d{1,2}):(\d{2})/);
    if (!match) return 0;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  };

  // Convert raw timestamps [MM:SS] in assistant markdown into interactive scrub badges
  const renderFormattedContent = (content: string) => {
    if (isUser) return <p className="leading-relaxed">{content}</p>;

    const parts = content.split(/(\[\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?\])/g);

    return (
      <div className="leading-relaxed space-y-1">
        {parts.map((part, index) => {
          const match = part.match(/\[(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?\]/);
          if (match) {
            const startSec = parseTimestampToSeconds(match[1]);
            return (
              <button
                key={index}
                type="button"
                onClick={() => onSeek(startSec)}
                className="inline-flex items-center gap-1 px-2 py-0.5 mx-1 rounded-md text-[11px] font-mono font-semibold bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/30 border border-indigo-500/30 transition-all cursor-pointer"
                title={`Jump to ${match[1]}`}
              >
                ▶ {part}
              </button>
            );
          }
          return <ReactMarkdown key={index}>{part}</ReactMarkdown>;
        })}
      </div>
    );
  };

  return (
    <div className={`flex gap-3 ${isUser ? "ml-auto flex-row-reverse" : ""} max-w-[92%] md:max-w-3xl`}>
      <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold ${
        isUser
          ? "bg-indigo-600 text-white"
          : "bg-zinc-800 text-indigo-400 border border-zinc-700/60"
      }`}>
        {isUser ? "You" : "AI"}
      </div>

      <div className={`p-4 rounded-2xl text-xs md:text-sm ${
        isUser
          ? "bg-indigo-600 text-white rounded-tr-sm"
          : "bg-zinc-900 border border-zinc-800/80 text-zinc-100 rounded-tl-sm shadow-xl"
      }`}>
        {renderFormattedContent(message.content)}
      </div>
    </div>
  );
}

/* ── Collapsible Sources Drawer with Clickable Timestamps ── */
function SourcesPanel({
  sources,
  onSeek,
}: {
  sources: string[];
  onSeek: (seconds: number) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const parseTimestampToSeconds = (ts: string): number => {
    const match = ts.match(/(\d{1,2}):(\d{2})/);
    if (!match) return 0;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  };

  return (
    <div className="ml-11">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="text-[11px] text-zinc-400 hover:text-indigo-400 transition-colors font-mono py-1 px-1 flex items-center gap-1.5 cursor-pointer"
      >
        <span>{isOpen ? "▾" : "▸"}</span>
        <span>{sources.length} retrieved context sources</span>
      </button>

      {isOpen && (
        <div className="mt-2 space-y-2 border-l border-zinc-800 pl-3">
          {sources.map((src, idx) => {
            const timeMatch = src.match(/(\d{1,2}:\d{2})/);
            const seconds = timeMatch ? parseTimestampToSeconds(timeMatch[1]) : null;

            return (
              <div
                key={idx}
                className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-3 text-xs text-zinc-300"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-zinc-400 text-[11px]">Chunk {idx + 1}</span>
                  {seconds !== null && (
                    <button
                      type="button"
                      onClick={() => onSeek(seconds)}
                      className="text-[10px] font-mono text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20 cursor-pointer"
                    >
                      ▶ Jump to {timeMatch ? timeMatch[1] : ""}
                    </button>
                  )}
                </div>
                <p className="leading-relaxed text-zinc-300">{src}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
