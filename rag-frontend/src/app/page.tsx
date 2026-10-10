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

  // ── Interactive Settings State ──
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [videoPosition, setVideoPosition] = useState<"stacked" | "split">("stacked");

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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Jump and play video at specific timestamp second
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
      setUploadStatus("Uploading video...");
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
              setUploadStatus("Video indexed successfully.");
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
    setUploadStatus("Indexing document...");

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
        setUploadStatus("Document indexed successfully.");
        setTimeout(() => setUploadStatus(""), 3000);
        setSidebarOpen(false);
      } else {
        setUploadStatus(`Error: ${data.detail || "Upload failed"}`);
      }
    } catch {
      setUploadStatus("Error: Could not reach backend");
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
            content: "⚠️ Unable to get a response. Please check server.",
          },
        ]);
      }
    } finally {
      setIsAsking(false);
    }
  };

  const handleResetSession = () => {
    setMessages([]);
    setSessionId("session_" + Math.random().toString(36).substring(2, 9));
  };

  const quickPrompts = [
    "Full overview of all advice and instructions",
    "What are the key moments and timestamps?",
    "Summarize the main takeaways",
  ];

  // Dynamic Theme Palette
  const theme = {
    bg: isDarkMode ? "bg-[#0c0c0e] text-[#ededed]" : "bg-[#f8f9fa] text-[#1a1a1e]",
    sidebar: isDarkMode ? "bg-[#121215] border-[#1f1f23]" : "bg-[#ffffff] border-[#e5e7eb] shadow-sm",
    card: isDarkMode ? "bg-[#18181c] border-[#27272c]" : "bg-[#f3f4f6] border-[#e5e7eb]",
    input: isDarkMode ? "bg-[#121215] border-[#1f1f23] text-white placeholder:text-[#52525b]" : "bg-[#ffffff] border-[#e5e7eb] text-[#111827] placeholder:text-[#9ca3af]",
    header: isDarkMode ? "border-[#1f1f23] bg-[#121215]/60" : "border-[#e5e7eb] bg-[#ffffff]/80",
    textMuted: isDarkMode ? "text-[#71717a]" : "text-[#6b7280]",
    chatUser: isDarkMode ? "bg-[#27272a] text-[#ededed]" : "bg-[#18181b] text-white",
    chatAi: isDarkMode ? "bg-[#121215] border-[#1f1f23] text-[#ededed]" : "bg-[#ffffff] border-[#e5e7eb] text-[#111827] shadow-sm",
  };

  return (
    <div className={`h-screen flex ${theme.bg} overflow-hidden font-sans selection:bg-amber-400/20 selection:text-amber-200 transition-colors duration-200`}>

      {/* ── Mobile Overlay ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ── */}
      <aside
        className={`
          fixed top-0 left-0 h-full z-40 w-80 ${theme.sidebar} border-r
          flex flex-col shrink-0 transition-transform duration-300 ease-out
          md:relative md:translate-x-0 md:w-72 md:z-auto
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Brand Header */}
        <div className={`p-6 border-b ${isDarkMode ? "border-[#1f1f23]" : "border-[#e5e7eb]"} flex items-center justify-between`}>
          <div>
            <div className="flex items-center gap-2">
              <h1 className={`text-xl font-bold tracking-tight ${isDarkMode ? "text-white" : "text-[#111827]"} font-sans`}>
                DocAI
              </h1>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
            </div>
            <p className={`text-[10px] ${theme.textMuted} uppercase tracking-widest mt-1 font-mono`}>
              Intelligence Studio
            </p>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className={`md:hidden ${theme.textMuted} hover:text-white p-1`}
          >
            ✕
          </button>
        </div>

        {/* Upload Zone */}
        <div className={`p-5 border-b ${isDarkMode ? "border-[#1f1f23]" : "border-[#e5e7eb]"}`}>
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
            <div className={`rounded-lg ${theme.card} p-4 border hover:border-amber-400/60 transition-all duration-200`}>
              <div className="flex items-center justify-between">
                <div className={`flex items-center gap-3 text-xs font-medium ${isDarkMode ? "text-[#d4d4d8]" : "text-[#374151]"} group-hover:text-amber-400`}>
                  {isUploading ? (
                    <>
                      <svg className="animate-spin h-3.5 w-3.5 text-amber-400" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      <span>Ingesting Media...</span>
                    </>
                  ) : (
                    <>
                      <span className="text-sm font-bold text-amber-400">+</span>
                      <span>Upload Video or Document</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </label>

          {/* Minimalist Gold Progress Line */}
          {videoProgress > 0 && (
            <div className={`mt-3.5 ${theme.card} p-3 rounded-lg border`}>
              <div className="flex justify-between items-center text-[10px] mb-2 font-mono">
                <span className="text-amber-400 truncate max-w-[170px] uppercase tracking-wider">{videoStep}</span>
                <span className={theme.textMuted}>/ {videoProgress}%</span>
              </div>
              <div className={`h-[2px] ${isDarkMode ? "bg-[#27272c]" : "bg-[#e5e7eb]"} overflow-hidden`}>
                <div
                  className="h-full bg-amber-400 transition-all duration-300"
                  style={{ width: `${videoProgress}%` }}
                />
              </div>
            </div>
          )}

          {uploadStatus && !videoProgress && (
            <p className={`text-[11px] text-center mt-3 font-mono ${
              uploadStatus.includes("Error") ? "text-rose-400" : "text-amber-400"
            }`}>
              {uploadStatus}
            </p>
          )}
        </div>

        {/* Active Source Card */}
        {uploadedFile && (
          <div className={`p-5 border-b ${isDarkMode ? "border-[#1f1f23]" : "border-[#e5e7eb]"}`}>
            <div className={`flex items-center justify-between text-[10px] font-mono ${theme.textMuted} uppercase tracking-widest mb-2.5`}>
              <span>Active Source</span>
              <span className="text-amber-400 font-bold">
                {uploadedFile.type === "video" ? "VIDEO" : "DOCUMENT"}
              </span>
            </div>
            <div className={`${theme.card} rounded-lg p-3.5 flex items-start justify-between gap-3 border`}>
              <div className="min-w-0">
                <p className={`text-xs font-medium ${isDarkMode ? "text-white" : "text-[#111827]"} truncate`}>{uploadedFile.name}</p>
                <p className={`text-[10px] ${theme.textMuted} mt-1 font-mono`}>
                  {uploadedFile.type === "video"
                    ? `${uploadedFile.wordCount} segments indexed`
                    : `${uploadedFile.wordCount.toLocaleString()} words indexed`}
                </p>
              </div>
              <button
                onClick={handleDelete}
                className={`${theme.textMuted} hover:text-amber-400 p-1 transition-colors`}
                title="Remove file"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* ── INTERACTIVE SETTINGS SECTION ── */}
        <div className="mt-auto p-5 border-t border-inherit space-y-4">
          <div className={`text-[10px] font-mono ${theme.textMuted} uppercase tracking-widest`}>
            Display & Controls
          </div>

          {/* Setting 1: Dark / Light Mode Toggle */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Appearance</span>
            <button
              type="button"
              onClick={() => setIsDarkMode(!isDarkMode)}
              className={`text-xs px-2.5 py-1 rounded-md border font-mono transition-colors flex items-center gap-1.5 cursor-pointer ${
                isDarkMode
                  ? "bg-[#18181c] border-[#27272c] text-amber-300 hover:border-amber-400/50"
                  : "bg-white border-[#e5e7eb] text-amber-600 hover:border-amber-500 shadow-sm"
              }`}
            >
              <span>{isDarkMode ? "🌙" : "☀️"}</span>
              <span>{isDarkMode ? "Dark" : "Light"}</span>
            </button>
          </div>

          {/* Setting 2: Video Layout Position Toggle (Stacked vs Split) */}
          {videoBlobUrl && (
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Video Layout</span>
              <button
                type="button"
                onClick={() => setVideoPosition(videoPosition === "stacked" ? "split" : "stacked")}
                className={`text-xs px-2.5 py-1 rounded-md border font-mono transition-colors cursor-pointer ${
                  isDarkMode
                    ? "bg-[#18181c] border-[#27272c] text-zinc-300 hover:border-amber-400/50"
                    : "bg-white border-[#e5e7eb] text-zinc-700 hover:border-amber-500 shadow-sm"
                }`}
              >
                {videoPosition === "stacked" ? "Top Banner" : "Split View"}
              </button>
            </div>
          )}

          {/* Setting 3: Reset Conversation */}
          <div className="flex items-center justify-between pt-1">
            <span className={`text-xs ${theme.textMuted}`}>Session</span>
            <button
              type="button"
              onClick={handleResetSession}
              className={`text-[11px] font-mono px-2 py-1 rounded transition-colors cursor-pointer ${
                isDarkMode ? "text-zinc-400 hover:text-white hover:bg-zinc-800" : "text-zinc-600 hover:text-black hover:bg-zinc-200"
              }`}
              title="Clear message history and start a new session"
            >
              ↺ Reset Chat
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main Canvas ── */}
      <main className="flex-1 flex flex-col min-w-0 h-full">

        {/* Minimalist Top Bar */}
        <header className={`px-6 py-4 border-b ${theme.header} backdrop-blur-md flex items-center justify-between shrink-0`}>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className={`md:hidden ${theme.textMuted} hover:text-amber-400 p-1`}
            >
              ☰
            </button>
            <div className="flex items-center gap-2.5">
              <span className={`text-xs font-mono ${isDarkMode ? "text-[#a1a1aa]" : "text-[#4b5563]"}`}>
                {uploadedFile ? uploadedFile.name : "Workspace"}
              </span>
              {uploadedFile && (
                <span className="text-[9px] font-mono uppercase bg-amber-400/10 text-amber-400 border border-amber-400/20 px-1.5 py-0.5 rounded">
                  Active
                </span>
              )}
            </div>
          </div>
        </header>

        {/* Content Container (Handles Split View vs Stacked View) */}
        <div className={`flex-1 overflow-y-auto p-4 md:p-8 ${videoPosition === "split" && videoBlobUrl ? "grid md:grid-cols-2 gap-6 max-w-7xl" : "max-w-4xl"} w-full mx-auto`}>

          {/* Video Player Panel */}
          {videoBlobUrl && (
            <div className={`${videoPosition === "split" ? "h-fit sticky top-0" : "mb-6"} ${theme.card} border rounded-xl p-4 shadow-xl`}>
              <div className="flex items-center justify-between mb-2.5 px-0.5">
                <span className={`text-[11px] font-mono ${isDarkMode ? "text-[#a1a1aa]" : "text-[#4b5563]"} uppercase tracking-wider flex items-center gap-2`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                  Video Preview
                </span>
                <span className={`text-[10px] font-mono ${theme.textMuted}`}>Click timestamps to scrub</span>
              </div>
              <video
                ref={videoRef}
                src={videoBlobUrl}
                controls
                className="w-full max-h-72 rounded-lg bg-black object-contain border border-inherit"
              />
            </div>
          )}

          {/* Chat Message List */}
          <div className="space-y-6">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center min-h-[50vh] text-center px-4">
                <h2 className={`text-3xl md:text-4xl font-bold tracking-tight ${isDarkMode ? "text-white" : "text-[#111827]"} mb-3`}>
                  {uploadedFile ? "Ask Anything." : "Work Anywhere."}
                </h2>
                <p className={`text-xs md:text-sm ${theme.textMuted} max-w-md leading-relaxed mb-8`}>
                  {uploadedFile
                    ? "Query specific timestamps or request a complete synthesis."
                    : "Upload a document or video to begin intelligent retrieval with timestamp citations."}
                </p>

                {/* Minimalist Quick Action Pills */}
                {uploadedFile && (
                  <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                    {quickPrompts.map((prompt, i) => (
                      <button
                        key={i}
                        onClick={() => handleAsk(prompt)}
                        className={`text-xs ${theme.card} hover:border-amber-400/60 px-4 py-2 rounded-lg transition-all duration-200 cursor-pointer border`}
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
                  <ChatMessage message={msg} onSeek={handleSeek} isDarkMode={isDarkMode} />
                  {msg.role === "assistant" && msg.sources && msg.sources.length > 0 && (
                    <SourcesPanel sources={msg.sources} onSeek={handleSeek} isDarkMode={isDarkMode} />
                  )}
                </div>
              ))
            )}

            {/* Typing indicator */}
            {isAsking && (
              <div className={`flex gap-2 items-center text-xs font-mono text-amber-400 ${theme.card} w-fit px-3.5 py-2 rounded-lg border`}>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
                Synthesizing...
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Minimalist Input Bar */}
        <div className={`p-4 md:p-6 border-t ${theme.header} shrink-0`}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAsk();
            }}
            className="max-w-4xl mx-auto flex gap-3"
          >
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                uploadedFile
                  ? `Ask about ${uploadedFile.name}...`
                  : "Upload a file to start..."
              }
              disabled={isAsking}
              className={`flex-1 ${theme.input} focus:border-amber-400/60 rounded-lg px-4 py-3 text-xs md:text-sm focus:outline-none transition-colors font-sans border`}
            />
            <button
              type="submit"
              disabled={isAsking || !question.trim() || !uploadedFile}
              className="px-6 py-3 bg-amber-400 hover:bg-amber-300 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-xs md:text-sm font-semibold text-black transition-colors shrink-0 cursor-pointer"
            >
              Send
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

/* ── Minimalist Chat Message with Interactive Gold Timestamps ── */
function ChatMessage({
  message,
  onSeek,
  isDarkMode,
}: {
  message: Message;
  onSeek: (seconds: number) => void;
  isDarkMode: boolean;
}) {
  const isUser = message.role === "user";

  const parseTimestampToSeconds = (ts: string): number => {
    const match = ts.match(/(\d{1,2}):(\d{2})/);
    if (!match) return 0;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  };

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
                className="inline-flex items-center gap-1 px-2 py-0.5 mx-1 rounded text-[11px] font-mono font-medium bg-amber-400/10 text-amber-400 hover:bg-amber-400/20 border border-amber-400/30 transition-colors cursor-pointer"
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
      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 text-[10px] font-mono font-bold ${
        isUser
          ? isDarkMode ? "bg-[#27272a] text-[#ededed]" : "bg-[#18181b] text-white"
          : isDarkMode ? "bg-[#18181c] text-amber-400 border border-[#27272c]" : "bg-[#f3f4f6] text-amber-600 border border-[#e5e7eb]"
      }`}>
        {isUser ? "YOU" : "AI"}
      </div>

      <div className={`p-4 rounded-xl text-xs md:text-sm ${
        isUser
          ? "bg-[#1f1f23] text-white rounded-tr-sm"
          : isDarkMode
            ? "bg-[#121215] border border-[#1f1f23] text-[#ededed] rounded-tl-sm shadow-xl"
            : "bg-[#ffffff] border border-[#e5e7eb] text-[#111827] rounded-tl-sm shadow-sm"
      }`}>
        {renderFormattedContent(message.content)}
      </div>
    </div>
  );
}

/* ── Minimalist Sources Drawer with Gold Timestamp Jump ── */
function SourcesPanel({
  sources,
  onSeek,
  isDarkMode,
}: {
  sources: string[];
  onSeek: (seconds: number) => void;
  isDarkMode: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const parseTimestampToSeconds = (ts: string): number => {
    const match = ts.match(/(\d{1,2}):(\d{2})/);
    if (!match) return 0;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  };

  return (
    <div className="ml-10">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`text-[10px] ${isDarkMode ? "text-[#71717a]" : "text-[#6b7280]"} hover:text-amber-400 transition-colors font-mono py-1 flex items-center gap-1.5 cursor-pointer`}
      >
        <span>{isOpen ? "▾" : "▸"}</span>
        <span>{sources.length} sources retrieved</span>
      </button>

      {isOpen && (
        <div className={`mt-2 space-y-2 border-l ${isDarkMode ? "border-[#1f1f23]" : "border-[#e5e7eb]"} pl-3`}>
          {sources.map((src, idx) => {
            const timeMatch = src.match(/(\d{1,2}:\d{2})/);
            const seconds = timeMatch ? parseTimestampToSeconds(timeMatch[1]) : null;

            return (
              <div
                key={idx}
                className={`${isDarkMode ? "bg-[#121215] border-[#1f1f23] text-[#a1a1aa]" : "bg-white border-[#e5e7eb] text-[#4b5563] shadow-sm"} border rounded-lg p-3 text-xs`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className={`font-mono ${isDarkMode ? "text-[#71717a]" : "text-[#9ca3af]"} text-[10px]`}>Segment {idx + 1}</span>
                  {seconds !== null && (
                    <button
                      type="button"
                      onClick={() => onSeek(seconds)}
                      className="text-[10px] font-mono text-amber-400 hover:text-amber-300 bg-amber-400/10 px-2 py-0.5 rounded border border-amber-400/20 cursor-pointer"
                    >
                      ▶ Jump to {timeMatch ? timeMatch[1] : ""}
                    </button>
                  )}
                </div>
                <p className={`leading-relaxed ${isDarkMode ? "text-[#d4d4d8]" : "text-[#1f2937]"}`}>{src}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
