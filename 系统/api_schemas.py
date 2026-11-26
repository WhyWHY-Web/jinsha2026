"""客户端与 FastAPI 的数据契约。"""
from typing import Literal

from pydantic import BaseModel, Field


class AgentMessage(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    station: str | None = Field(default=None, max_length=100)


class Evidence(BaseModel):
    label: str
    value: float | int | str | None
    unit: str
    source: str


class StationLocation(BaseModel):
    name: str
    lon: float
    lat: float


class AgentReply(BaseModel):
    ok: bool
    conclusion: str
    evidence: list[Evidence]
    suggestion: str
    confidence: str
    action: Literal['browse', 'locate', 'assessment', 'governance']
    station: StationLocation | None
