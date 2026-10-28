from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List
from app.services.key_manager import key_manager

router = APIRouter(prefix="/api/keys", tags=["API Keys Pool"])

class AddKeyPayload(BaseModel):
    key: str
    label: Optional[str] = None

@router.get("")
async def get_keys():
    """
    Returns list of all stored API keys with masked secrets.
    Raw keys are never returned.
    """
    return {
        "status": "success",
        "keys": key_manager.list_keys(),
        "summary": key_manager.get_pool_summary()
    }

@router.get("/summary")
async def get_summary():
    """
    Returns summary statistics of active keys for the header pill.
    """
    return {
        "status": "success",
        "summary": key_manager.get_pool_summary()
    }

@router.post("")
async def add_key(payload: AddKeyPayload):
    """
    Validates a Gemini API key against Google's API, masks it,
    and adds it to the Round-Robin pool.
    """
    if not payload.key or len(payload.key.strip()) < 15:
        raise HTTPException(status_code=400, detail="Please enter a valid Gemini API key.")

    success, message, record = key_manager.add_key(payload.key, payload.label)
    if not success:
        raise HTTPException(status_code=400, detail=message)

    return {
        "status": "success",
        "message": message,
        "key": record,
        "summary": key_manager.get_pool_summary()
    }

@router.delete("/{key_id}")
async def delete_key(key_id: str):
    """
    Deletes an API key from the Round-Robin pool.
    """
    success, message = key_manager.delete_key(key_id)
    if not success:
        raise HTTPException(status_code=404, detail=message)

    return {
        "status": "success",
        "message": message,
        "summary": key_manager.get_pool_summary()
    }

@router.post("/test-all")
async def test_all_keys():
    """
    Sends real-time verification pings across all stored API keys
    and returns latency and active/rate-limited status.
    """
    results = key_manager.test_all_keys()
    return {
        "status": "success",
        "results": results,
        "summary": key_manager.get_pool_summary()
    }

@router.post("/{key_id}/test")
async def test_single_key(key_id: str):
    """
    Tests a specific key and returns real-time status & latency.
    """
    result = key_manager.test_key(key_id)
    if result.get("status") == "error":
        raise HTTPException(status_code=404, detail=result.get("message"))

    return {
        "status": "success",
        "result": result,
        "summary": key_manager.get_pool_summary()
    }
