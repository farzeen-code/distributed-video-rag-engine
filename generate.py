import os
import time
import socket
import truststore
from dotenv import load_dotenv
from google import genai
from google.genai.errors import APIError
from google.genai import Client, types

load_dotenv()

truststore.inject_into_ssl()

orig_getaddrinfo = socket.getaddrinfo
def getaddrinfo_ipv4(*args, **kwargs):
    responses = orig_getaddrinfo(*args, **kwargs)
    return [r for r in responses if r[0] == socket.AF_INET]
socket.getaddrinfo = getaddrinfo_ipv4

client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

def build_prompt(query: str, context_chunks: list[str], history: list[dict]) -> str:

    context_text = "\n\n---\n\n".join(context_chunks)
    history_text = ""
    if history:
        history_lines = [f"{turn['role'].capitalize()}: {turn['content']}" for turn in history]
        history_text = "\n".join(history_lines)
    prompt = f"""You are an intelligent document analysis assistant. 

        Here is the conversation history:
        {history_text}

        Here is the document context:
        {context_text}

        User Question: {query}

        Instructions:
        1. Answer the user's question accurately using ONLY the provided context.
        2. Video Timestamps: If the context contains video timestamp brackets like [MM:SS - MM:SS] or [MM:SS], you MUST explicitly cite the exact timestamp in your answer (e.g., "At [04:15], the speaker explains..."). This allows the user to jump directly to that point in the video.
        3. Strict Grounding: Never guess, extrapolate, or invent timestamps. If a fact is present without a timestamp, state the fact without inventing a time.
        4. Missing Information: If the context does not contain the answer, politely state that the information is not covered in the provided documents or video.
        5. Analytical Questions: If the user asks for a comparison, summary, or subjective judgment, evaluate the provided context thoroughly and explain the rationale behind your conclusions.
        6. Formatting: Use Markdown formatting (bolding, bullet points, clean quotes) to make timestamps and key takeaways immediately readable."""

    return prompt

def generate_answer(query: str, context_chunks: list[str], history: list[dict]) -> str:
    
    if not context_chunks or all(not c for c in context_chunks):
        return "⚠️ No relevant document context found. Please upload a document first."

    prompt = build_prompt(query, context_chunks, history)

    diff_models = [
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash-lite",
        "gemini-flash-lite-latest",
        "gemini-3.5-flash"
    ]
    
    print(f"\n---- DEBUG generate_answer------\n")
    print(f"Prompt length: {len(prompt)}")
    print(f"Models to try: {diff_models}")

    for model_name in diff_models:
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt
            )
            # Handle empty or None response
            if response.text:
                print(f"Success with model: {model_name}")
                return response.text
            print(f"⚠️ Empty response from {model_name}")
            continue
        
        except Exception as e:
            err_msg = str(e).lower()
            if "timeout" in err_msg:
                print(f"⚠️ TIMEOUT on {model_name} after 30s")
            elif "503" in err_msg or "unavailable" in err_msg or "429" in err_msg:
                print(f"⚠️ High demand / 503 on {model_name}, trying fallback model after 1s pause...")
                time.sleep(1)
            else:
                print(f"⚠️ API error on {model_name}: {e}")
            continue

    
    return "⚠️ AI service is temporarily overloaded. Please try again in a few minutes."