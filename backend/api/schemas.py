"""Pydantic schemas for API."""
from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    access_code: str


class LoginResponse(BaseModel):
    success: bool
    message: Optional[str] = None
    user: Optional[dict] = None
    token: Optional[str] = None


class UserOut(BaseModel):
    username: str
    full_name: Optional[str] = None
    user_type: str
    project_site: Optional[str] = None


class ItemCreate(BaseModel):
    name: str
    qty: float = Field(default=0, ge=0)
    unit: str = "pcs"
    unit_cost: float = Field(default=0, ge=0)
    category: str
    budget: str
    section: str
    building_type: str
    grp: Optional[str] = None
    project_site: Optional[str] = None


class ItemUpdate(BaseModel):
    qty: Optional[float] = Field(default=None, ge=0)
    unit_cost: Optional[float] = Field(default=None, ge=0)


class ItemOut(BaseModel):
    id: int
    code: Optional[str] = None
    name: str
    category: str
    unit: str
    qty: float
    unit_cost: float
    budget: Optional[str] = None
    section: Optional[str] = None
    grp: Optional[str] = None
    building_type: Optional[str] = None
    project_site: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class RequestCreate(BaseModel):
    item_id: int
    qty: float = Field(gt=0)
    requested_by: Optional[str] = None
    current_price: Optional[float] = Field(default=None, ge=0)
    note: Optional[str] = None
    building_subtype: Optional[str] = None
    project_site: Optional[str] = None


class RequestStatusUpdate(BaseModel):
    status: str  # Approved, Rejected, Pending
    approved_by: Optional[str] = None
    note: Optional[str] = None


class RequestOut(BaseModel):
    id: int
    ts: Optional[datetime] = None
    section: Optional[str] = None
    item_id: int
    item_name: Optional[str] = None
    budget: Optional[str] = None
    qty: float
    requested_by: str
    note: Optional[str] = None
    building_subtype: Optional[str] = None
    status: str
    approved_by: Optional[str] = None
    current_price: Optional[float] = None
    project_site: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ActualCreate(BaseModel):
    item_id: int
    actual_qty: float = Field(gt=0)
    actual_cost: float = Field(ge=0)
    actual_date: datetime
    recorded_by: str
    notes: Optional[str] = None
    building_subtype: Optional[str] = None
    project_site: Optional[str] = None


class ActualOut(BaseModel):
    id: int
    item_id: int
    actual_qty: float
    actual_cost: float
    actual_date: datetime
    recorded_by: str
    notes: Optional[str] = None
    building_subtype: Optional[str] = None
    project_site: Optional[str] = None

    class Config:
        from_attributes = True


class ProjectSiteCreate(BaseModel):
    name: str
    user_code: str  # Project site passcode (required)
    description: Optional[str] = None


class ProjectSiteUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class ProjectSiteOut(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    created_at: Optional[datetime] = None
    user_code: Optional[str] = None

    class Config:
        from_attributes = True


class AccessCodeUpdate(BaseModel):
    admin_code: str


class ProjectSiteAccessCodeUpdate(BaseModel):
    user_code: str


class NotificationOut(BaseModel):
    id: int
    notification_type: str
    title: str
    message: Optional[str] = None
    item_name: Optional[str] = None
    qty: Optional[float] = None
    budget: Optional[str] = None
    building_subtype: Optional[str] = None
    is_read: bool
    created_at: datetime

    class Config:
        from_attributes = True


class AccessLogOut(BaseModel):
    id: int
    access_code: Optional[str] = None
    user_name: Optional[str] = None
    access_time: datetime
    success: bool
    role: Optional[str] = None

    class Config:
        from_attributes = True


class BulkUploadItemRow(BaseModel):
    name: str
    qty: float = Field(ge=0)
    unit: str
    unit_cost: float = Field(ge=0)
    category: str
    budget: str
    section: str
    building_type: str
    project_site: str
    grp: Optional[str] = None


class BulkUploadRowError(BaseModel):
    row_number: int
    field: str
    message: str


class BulkUploadPreviewOut(BaseModel):
    file_name: str
    total_rows: int
    valid_rows_count: int
    error_count: int
    errors: List[BulkUploadRowError]
    valid_rows: List[BulkUploadItemRow]


class BulkUploadCommitIn(BaseModel):
    rows: List[BulkUploadItemRow]


class BulkUploadCommitOut(BaseModel):
    inserted_count: int
    created_codes: List[str]


class BulkUploadTemplateOut(BaseModel):
    headers: List[str]
    sample_row: BulkUploadItemRow


class FileViewerSheetOut(BaseModel):
    sheet_name: str
    headers: List[str]
    rows: List[List[str]]
    total_rows: int
    returned_rows: int
    truncated: bool


class FileViewerOut(BaseModel):
    file_name: str
    sheets: List[FileViewerSheetOut]
