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

  const quickPrompts = [
    "Full overview of all advice and instructions",
    "What are the key moments and timestamps?",
    "Summarize the main takeaways",
  ];

  return (
    <div className="h-screen flex bg-[#0c0c0e] text-[#ededed] overflow-hidden font-sans selection:bg-amber-400/20 selection:text-amber-200">

      {/* ── Mobile Overlay ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Matte Charcoal Sidebar ── */}
      <aside
        className={`
          fixed top-0 left-0 h-full z-40 w-80 bg-[#121215] border-r border-[#1f1f23]
          flex flex-col shrink-0 transition-transform duration-300 ease-out
          md:relative md:translate-x-0 md:w-72 md:z-auto
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Brand Header */}
        <div className="p-6 border-b border-[#1f1f23] flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-white font-sans">
                DocAI
              </h1>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
            </div>
            <p className="text-[10px] text-[#71717a] uppercase tracking-widest mt-1 font-mono">
              Intelligence Studio
            </p>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden text-[#71717a] hover:text-white p-1"
          >
            ✕
          </button>
        </div>

        {/* Upload Zone */}
        <div className="p-5 border-b border-[#1f1f23]">
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
            <div className="rounded-lg bg-[#18181c] p-4 border border-[#27272c] hover:border-amber-400/50 transition-all duration-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-xs font-medium text-[#d4d4d8] group-hover:text-white">
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
                      <span className="text-sm text-amber-400">+</span>
                      <span>Upload Video or Document</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </label>

          {/* Minimalist Gold Progress Line (Inspired by Aer "/ 01" indicator) */}
          {videoProgress > 0 && (
            <div className="mt-3.5 bg-[#18181c] border border-[#27272c] p-3 rounded-lg">
              <div className="flex justify-between items-center text-[10px] mb-2 font-mono">
                <span className="text-amber-300 truncate max-w-[170px] uppercase tracking-wider">{videoStep}</span>
                <span className="text-[#a1a1aa]">/ {videoProgress}%</span>
              </div>
              <div className="h-[2px] bg-[#27272c] overflow-hidden">
                <div
                  className="h-full bg-amber-400 transition-all duration-300"
                  style={{ width: `${videoProgress}%` }}
                />
              </div>
            </div>
          )}

          {uploadStatus && !videoProgress && (
            <p className={`text-[11px] text-center mt-3 font-mono ${
              uploadStatus.includes("Error") ? "text-rose-400" : "text-amber-300"
            }`}>
              {uploadStatus}
            </p>
          )}
        </div>

        {/* Active Source Card */}
        {uploadedFile && (
          <div className="p-5 border-b border-[#1f1f23]">
            <div className="flex items-center justify-between text-[10px] font-mono text-[#71717a] uppercase tracking-widest mb-2.5">
              <span>Active Source</span>
              <span className="text-amber-400">
                {uploadedFile.type === "video" ? "VIDEO" : "DOCUMENT"}
              </span>
            </div>
            <div className="bg-[#18181c] border border-[#27272c] rounded-lg p-3.5 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-white truncate">{uploadedFile.name}</p>
                <p className="text-[10px] text-[#71717a] mt-1 font-mono">
                  {uploadedFile.type === "video"
                    ? `${uploadedFile.wordCount} segments indexed`
                    : `${uploadedFile.wordCount.toLocaleString()} words indexed`}
                </p>
              </div>
              <button
                onClick={handleDelete}
                className="text-[#71717a] hover:text-white p-1 transition-colors"
                title="Remove file"
              >
                ✕
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* ── Main Canvas ── */}
      <main className="flex-1 flex flex-col min-w-0 h-full bg-[#0c0c0e]">

        {/* Minimalist Top Bar */}
        <header className="px-6 py-4 border-b border-[#1f1f23] bg-[#121215]/60 backdrop-blur-md flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden text-[#71717a] hover:text-white p-1"
            >
              ☰
            </button>
            <div className="flex items-center gap-2.5">
              <span className="text-xs font-mono text-[#a1a1aa]">
                {uploadedFile ? uploadedFile.name : "Workspace"}
              </span>
              {uploadedFile && (
                <span className="text-[9px] font-mono uppercase bg-amber-400/10 text-amber-300 border border-amber-400/20 px-1.5 py-0.5 rounded">
                  Active
                </span>
              )}
            </div>
          </div>
        </header>

        {/* Message Area & Video */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 max-w-4xl w-full mx-auto">

          {/* Embedded Video Player Panel */}
          {videoBlobUrl && (
            <div className="bg-[#121215] border border-[#1f1f23] rounded-xl p-4 shadow-2xl">
              <div className="flex items-center justify-between mb-2.5 px-0.5">
                <span className="text-[11px] font-mono text-[#a1a1aa] uppercase tracking-wider flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                  Video Preview
                </span>
                <span className="text-[10px] font-mono text-[#71717a]">Click citations below to scrub player</span>
              </div>
              <video
                ref={videoRef}
                src={videoBlobUrl}
                controls
                className="w-full max-h-72 rounded-lg bg-black object-contain border border-[#1f1f23]"
              />
            </div>
          )}

          {/* Empty State */}
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[55vh] text-center px-4">
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-white mb-3">
                {uploadedFile ? "Ask Anything." : "Work Anywhere."}
              </h2>
              <p className="text-xs md:text-sm text-[#71717a] max-w-md leading-relaxed mb-8">
                {uploadedFile
                  ? "Query specific timestamps or request a complete synthesis."
                  : "Upload a document or video to begin intelligent retrieval with timestamp citations."}
              </p>

              {/* Minimalist Quick Prompt Pills */}
              {uploadedFile && (
                <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                  {quickPrompts.map((prompt, i) => (
                    <button
                      key={i}
                      onClick={() => handleAsk(prompt)}
                      className="text-xs bg-[#121215] hover:bg-[#18181c] border border-[#27272c] hover:border-amber-400/40 text-[#a1a1aa] hover:text-white px-4 py-2 rounded-lg transition-all duration-200 cursor-pointer"
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

          {/* Typing indicator */}
          {isAsking && (
            <div className="flex gap-2 items-center text-xs font-mono text-amber-300/80 bg-[#121215] border border-[#1f1f23] w-fit px-3.5 py-2 rounded-lg">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
              Synthesizing...
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Minimalist Input Bar */}
        <div className="p-4 md:p-6 border-t border-[#1f1f23] bg-[#0c0c0e] shrink-0">
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
              className="flex-1 bg-[#121215] border border-[#1f1f23] focus:border-amber-400/50 rounded-lg px-4 py-3 text-xs md:text-sm text-white placeholder:text-[#52525b] focus:outline-none transition-colors font-sans"
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

/* ── Minimalist Chat Message with Gold Timestamp Buttons ── */
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
                className="inline-flex items-center gap-1 px-2 py-0.5 mx-1 rounded text-[11px] font-mono font-medium bg-amber-400/10 text-amber-300 hover:bg-amber-400/20 border border-amber-400/30 transition-colors cursor-pointer"
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
          ? "bg-[#27272a] text-[#ededed]"
          : "bg-[#18181c] text-amber-400 border border-[#27272c]"
      }`}>
        {isUser ? "YOU" : "AI"}
      </div>

      <div className={`p-4 rounded-xl text-xs md:text-sm ${
        isUser
          ? "bg-[#1f1f23] text-white rounded-tr-sm"
          : "bg-[#121215] border border-[#1f1f23] text-[#ededed] rounded-tl-sm shadow-xl"
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
    <div className="ml-10">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="text-[10px] text-[#71717a] hover:text-amber-300 transition-colors font-mono py-1 flex items-center gap-1.5 cursor-pointer"
      >
        <span>{isOpen ? "▾" : "▸"}</span>
        <span>{sources.length} sources retrieved</span>
      </button>

      {isOpen && (
        <div className="mt-2 space-y-2 border-l border-[#1f1f23] pl-3">
          {sources.map((src, idx) => {
            const timeMatch = src.match(/(\d{1,2}:\d{2})/);
            const seconds = timeMatch ? parseTimestampToSeconds(timeMatch[1]) : null;

            return (
              <div
                key={idx}
                className="bg-[#121215] border border-[#1f1f23] rounded-lg p-3 text-xs text-[#a1a1aa]"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono text-[#71717a] text-[10px]">Segment {idx + 1}</span>
                  {seconds !== null && (
                    <button
                      type="button"
                      onClick={() => onSeek(seconds)}
                      className="text-[10px] font-mono text-amber-300 hover:text-amber-200 bg-amber-400/10 px-2 py-0.5 rounded border border-amber-400/20 cursor-pointer"
                    >
                      ▶ Jump to {timeMatch ? timeMatch[1] : ""}
                    </button>
                  )}
                </div>
                <p className="leading-relaxed text-[#d4d4d8]">{src}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
