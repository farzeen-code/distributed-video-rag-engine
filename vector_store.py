import os
import hashlib
import re
import chromadb
from google import genai
from embeddings import get_embedding_function, chunk_text
from memory import db


ai_client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

def is_summary_intent(query: str) -> bool:
    """
    Uses a fast 100ms LLM call to dynamically detect if the user
    wants a full overview/rundown vs a pinpoint fact.
    No hardcoded keywords!
    """
    
    prompt = f""" Classify the user's intent into exactly one word: 'SUMMARY' or 'PINPOINT'.
                - 'SUMMARY': If asking for an overview, full list of points/advice, outline, complete rundown, or general gist.
                - 'PINPOINT': If asking about a specific detail, single fact, specific quote, or focused topic.
                Question: "{query}"
                Answer with ONLY the word 'SUMMARY' or 'PINPOINT':
    """
    
    try:
        response = ai_client.models.generate_content(
            model="gemini-3.1-flash-lite",
            contents=prompt
        )
        
        classification = response.text.strip().upper()
        print(f"[Router] intent classified as {classification}")
        return "SUMMARY" in classification
    
    except Exception as e:
        print(f"[Router] fallback to pinpoint due to error: {e}")
        return False

def get_collection():
    client = chromadb.PersistentClient(path="chroma_db")
    return client.get_or_create_collection(
        name="documents",
        embedding_function=get_embedding_function()
    )

small_doc_threshold = 200

small_docs = db["small_documents"]

def add_chunk(chunks, filename):
    if not chunks:
        return

    collection=get_collection()
    collection.delete(where={"source": filename})
    
    # Process embeddings in small batches to keep memory overhead flat (<20MB)
    all_embeddings = []
    batch_size = 16
    embed_fn = get_embedding_function()
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i + batch_size]
        all_embeddings.extend(embed_fn(batch))
        
    ids = [hashlib.md5((f"{filename}_{i}_{chunk}").encode()).hexdigest() for i, chunk in enumerate(chunks)]

    metadatas = [{"source": filename} for _ in chunks]
    collection.upsert(documents=chunks, embeddings=all_embeddings, ids=ids, metadatas=metadatas)

def retrieve(question: str, filename: str=None, top_k: int=5, max_distance: float=1.25) -> list[str]:
    collection=get_collection()
    where_filter = {"source": filename.lower()} if filename else None

    results = collection.query(
        query_texts = [question],
        n_results = top_k,
        where = where_filter,
        include=["documents", "distances"]
    )
    
    if not results["documents"] or not results["documents"][0]:
        return []

    docs = results["documents"][0]
    distances = results["distances"][0] if "distances" in results and results["distances"] else [0.0] * len(docs)
    
    filtered_chunks=[]
    for doc, dist in zip(docs, distances):
        if dist <= max_distance:
            filtered_chunks.append(doc)
        else:
            print(f" Dropped irrelevant chunk (distance {dist:.2f} > max_distance)")
    
    if not filtered_chunks and docs:
        print(f"All chuks exceed the broad query threshold. Using best available chunks as a fallback.")
        return docs[:3]
    
    return filtered_chunks 

def get_full_transcript(filename: str) -> list[str]:
    
    """
    Retrieves the complete, chronological transcript of a video or document.
    Use this tool when the user wants an overview, full list of instructions/advice,
    or a comprehensive summary of everything in the video.
    """                     
    
    collection = get_collection()
    if not filename:
        return []
    
    results = collection.get(
        where={"source": filename.lower()},
        include=["documents"]
    )
    
    docs = results.get("documents", [])
    print(f"[Tool] get_full_transcript retrieved all {len(docs)} segments for {filename} ")
    return docs

def store_document(text, filename):
    collection=get_collection()
    if filename:
        filename = filename.lower()
    word_count = len(text.split())
    print(f"\n----- Debug---- store_document\n")
    print(f"Filename: '{filename}', Word count: {word_count}" )
    
    if word_count < small_doc_threshold:
        result = small_docs.update_one(
            {"filename": filename},
            {"$set": {"text": text}},
            upsert=True
        )
        collection.delete(where={"source": filename})
        print(f"Upserted into small_documents. matched={result.matched_count}, modified={result.modified_count}")
        return word_count, True

    else:
        small_docs.delete_one({"filename": filename})
        chunks = chunk_text(text)
        add_chunk(chunks, filename)
        print(f"Stored {len(chunks)} in ChromaDB")
        return word_count, False

def delete_document(filename):
    collection=get_collection()
    filename = filename.lower()
    collection.delete(where={"source": filename})
    small_docs.delete_one({"filename": filename})

def get_context(query, filename):
    print(f"\n--- debug Content----\n")
    print(f"Looking up filename: {filename}")
    if filename:
        small_doc = small_docs.find_one({
            "filename": {"$regex": f"^{re.escape(filename)}$", "$options": "i"}
        })
        if small_doc:
            print(f"Found in MongoDB {len(small_doc['text'])} chars")
            return [small_doc["text"]]

        print(f"Not found in small_documents, Checking chromaDB.....\n")
        
    if filename and is_summary_intent(query):
        print(f"User requested full overview for '{filename}'. Fetching all transcript chunks...")
        all_chunks = get_full_transcript(filename)
        if all_chunks:
            return all_chunks
    
    print(f"[Router] User requested specific detail. Running top-5 vector similarity search")    
    results = retrieve(query, filename, top_k=5)
    return results