import os
import re
from google import genai
from chromadb import Documents, EmbeddingFunction, Embeddings

_genai_client = None

def get_genai_client():
    global _genai_client
    if _genai_client is None:
        _genai_client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
    return _genai_client

class GeminiEmbeddingFunction(EmbeddingFunction[Documents]):
    def __init__(self):
        self.model_name = "gemini-embedding-001"

    def __call__(self, input: Documents) -> Embeddings:
        if not input:
            return []
        valid_input = [str(item) for item in input if str(item).strip()]
        if not valid_input:
            return []
        client = get_genai_client()
        response = client.models.embed_content(
            model=self.model_name,
            contents=valid_input,
            config={"output_dimensionality": 768}
        )
        return [e.values for e in response.embeddings]

embedding_fn = None

def get_embedding_function():
    global embedding_fn
    if embedding_fn is None:
        embedding_fn = GeminiEmbeddingFunction()
    return embedding_fn
        
    
def chunk_text(text: str, chunk_size: int=600, overlap: int=100):
    if not text or not text.strip():
        return []
    
    separators = ["\n\n", "\n", r"(?<=[.?!])\s+", " "]
    
    def split_recursive(content: str, sep_index: int) -> list[str]:
        if len(content) <= chunk_size or sep_index >= len(separators):
            return [content.strip()] if content.strip() else []
        
        sep = separators[sep_index]
        if sep.startswith(r"(?<="):
            parts = re.split(sep, content)
        else:
            parts = content.split(sep)
            
        chunks = []
        current_chunk = ""
        
        for part in parts:
            part = part.strip()
            if not part:
                continue
            
            if len(current_chunk) + len(part) +1 > chunk_size:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                    current_chunk = current_chunk[-overlap:] + " " + part if len(current_chunk) > overlap else part
                else:
                    chunks.extend(split_recursive(part, sep_index+1))
                    
            else:
                current_chunk = f"{current_chunk} {part}".strip()
        
        if current_chunk:
            chunks.append(current_chunk.strip())
            
        return chunks

    return split_recursive(text, 0)
                