import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app import db
from app.schemas import HistoryResponse

router = APIRouter()


@router.get("/sessions/{session_id}/messages", response_model=HistoryResponse,
            responses={404: {"description": "Session not found"}})
def get_messages(session_id: str):
    if not db.session_exists(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    messages = []
    for m in db.get_history(session_id):  # oldest first; system prompt is never stored here
        item = {"role": m.role, "content": m.content}
        if m.role == "assistant" and m.meta:
            item["metadata"] = json.loads(m.meta)
        messages.append(item)
    # Plain dict (validated against HistoryResponse for docs) so user rows carry no
    # "metadata" key while null values inside assistant metadata (key_id) are kept.
    HistoryResponse(session_id=session_id, messages=messages)
    return JSONResponse({"session_id": session_id, "messages": messages})
