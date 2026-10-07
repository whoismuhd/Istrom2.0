"""Pydantic schemas for API."""
from datetime import datetime
from typing import Optional, List, Dict, Literal, Annotated
from pydantic import BaseModel as PydanticBaseModel, ConfigDict, Field, AfterValidator, model_validator, field_validator
import re
import unicodedata
from api.account_policy import ADMIN_LOGIN_NAME


def validate_access_code(value: str) -> str:
    value = value.strip()
    if not value or len(value.encode("utf-8")) > 72:
        raise ValueError("Access code must contain 1 to 72 bytes.")
    return value


AccessCodeText = Annotated[str, Field(max_length=256), AfterValidator(validate_access_code)]


class BaseModel(PydanticBaseModel):
    model_config = ConfigDict(allow_inf_nan=False)


class LoginRequest(BaseModel):
    username: Optional[str] = Field(default=None, min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=128)
    user_type: Literal['admin', 'project_site']

    @model_validator(mode='after')
    def login_name(self):
        if self.user_type == 'admin':
            self.username = ADMIN_LOGIN_NAME
        elif not self.username or not self.username.strip():
            raise ValueError('Enter your username.')
        return self


def validate_username(value: str) -> str:
    value = value.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.@-]{2,79}", value):
        raise ValueError("Username must be 3 to 80 characters: letters, numbers, dots, @, underscores or hyphens.")
    return value


def validate_password(value: str) -> str:
    value = unicodedata.normalize('NFC', value)
    if len(value) < 8 or not value.strip():
        raise ValueError("Use a password or passphrase of at least 8 characters.")
    if len(set(value)) == 1 or value.lower() in ('password', 'password1', '12345678', '123456789', 'qwertyui', 'qwertyuiop', 'passwordpassword', 'passwordpassword1', '123456789012345', '1234567890123456', 'qwertyuiopasdfgh'):
        raise ValueError('Choose a less common password or a longer passphrase.')
    return value


UsernameText = Annotated[str, Field(max_length=80), AfterValidator(validate_username)]
PasswordText = Annotated[str, Field(max_length=128), AfterValidator(validate_password)]


class AdminSetupRequest(BaseModel):
    access_code: AccessCodeText
    password: PasswordText


class UserDetails(BaseModel):
    user_type: Literal['admin', 'project_site']
    project_site: Optional[str] = Field(default=None, max_length=255)


class UserCreate(UserDetails):
    username: UsernameText
    password: PasswordText

    @model_validator(mode='after')
    def reserved_username(self):
        if self.user_type == 'project_site' and self.username == ADMIN_LOGIN_NAME:
            raise ValueError('This username is reserved for the administrator.')
        return self


class UserUpdate(UserDetails):
    is_active: bool


class PasswordReset(BaseModel):
    password: PasswordText


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: PasswordText


class AdminRecoveryRequest(BaseModel):
    # The recipient and account are always selected by the backend.
    model_config = ConfigDict(extra='forbid')


class AdminRecoveryReset(BaseModel):
    model_config = ConfigDict(extra='forbid')
    token: str = Field(min_length=43, max_length=43, pattern=r'^[A-Za-z0-9_-]{43}$')
    new_password: PasswordText
    confirm_password: PasswordText

    @model_validator(mode='after')
    def matching_passwords(self):
        if self.new_password != self.confirm_password:
            raise ValueError('The passwords do not match.')
        return self


class ManagedUserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    user_type: str
    project_site: Optional[str]
    is_active: bool
    must_change_password: bool
    created_at: Optional[datetime]
    last_login_at: Optional[datetime]


class LoginResponse(BaseModel):
    success: bool
    message: Optional[str] = None
    user: Optional[dict] = None
    token: Optional[str] = None


class UserOut(BaseModel):
    username: str
    user_type: str
    project_site: Optional[str] = None


class ItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    qty: float = Field(default=0, ge=0)
    unit: str = Field(default='pcs', min_length=1, max_length=50)
    unit_cost: float = Field(default=0, ge=0)
    category: str = Field(max_length=50)
    budget: str = Field(max_length=255)
    section: str = Field(max_length=255)
    building_type: str = Field(max_length=100)
    grp: Optional[str] = Field(default=None, max_length=255)
    project_site: Optional[str] = Field(default=None, max_length=255)

    @field_validator('name', 'unit')
    @classmethod
    def nonblank_item_text(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Item name and unit cannot be blank.')
        return value


class ItemUpdate(BaseModel):
    expected_qty: Optional[float] = None
    qty: Optional[float] = None
    unit_cost: Optional[float] = Field(default=None, ge=0)
    planned_qty: Optional[float] = Field(default=None, ge=0)
    planned_unit_cost: Optional[float] = Field(default=None, ge=0)


class ItemOut(BaseModel):
    id: int
    code: Optional[str] = None
    name: str
    category: str
    unit: str
    qty: float
    unit_cost: float
    planned_qty: float
    planned_unit_cost: float
    budget: Optional[str] = None
    section: Optional[str] = None
    grp: Optional[str] = None
    building_type: Optional[str] = None
    budget_scope: Optional[str] = None
    source_sheet: Optional[str] = None
    source_row: Optional[int] = None
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
    building_subtype: Optional[str] = Field(default=None, max_length=100)
    project_site: Optional[str] = Field(default=None, max_length=255)


class RequestStatusUpdate(BaseModel):
    status: str  # Approved, Rejected, Pending
    approved_by: Optional[str] = None
    note: Optional[str] = None


class RequestOut(BaseModel):
    id: int
    item_unit: Optional[str] = None
    item_unit_cost: Optional[float] = None
    item_building_type: Optional[str] = None
    item_section: Optional[str] = None
    actual_cost: Optional[float] = None
    available_qty: Optional[float] = None
    shortage_qty: float = 0
    approved_shortage_qty: float = 0
    ts: Optional[datetime] = None
    section: Optional[str] = None
    item_id: int
    item_name: Optional[str] = None
    item_budget_scope: Optional[str] = None
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
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ActualCreate(BaseModel):
    item_id: int
    actual_qty: float = Field(gt=0)
    actual_cost: float = Field(ge=0)
    actual_date: datetime
    recorded_by: str
    notes: Optional[str] = None
    building_subtype: Optional[str] = Field(default=None, max_length=100)
    project_site: Optional[str] = Field(default=None, max_length=255)


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
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)


class ProjectSiteUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)


class ProjectSiteOut(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class AccessCodeUpdate(BaseModel):
    admin_code: AccessCodeText


class ProjectSiteAccessCodeUpdate(BaseModel):
    user_code: AccessCodeText


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
    name: str = Field(min_length=1, max_length=255)
    qty: float = Field(ge=0)
    unit: str = Field(min_length=1, max_length=50)
    unit_cost: float = Field(ge=0)
    category: str = Field(max_length=50)
    budget: str = Field(max_length=255)
    section: str = Field(max_length=255)
    building_type: str = Field(max_length=100)
    project_site: str = Field(max_length=255)
    grp: Optional[str] = Field(default=None, max_length=255)
    budget_scope: str = Field(default='', max_length=255)
    source_sheet: Optional[str] = Field(default=None, max_length=255)
    source_row: Optional[int] = Field(default=None, ge=1, le=10000)
    import_sheet: Optional[str] = Field(default=None, max_length=800)
    source_qty: Optional[float] = Field(default=None, ge=0)

    @field_validator('name', 'unit')
    @classmethod
    def nonblank_item_text(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Item name and unit cannot be blank.')
        return value


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
    valid_rows: List[BulkUploadItemRow] = Field(max_length=2000)


class WorkbookSheetCheck(BaseModel):
    sheet_name: str = Field(max_length=800)
    multiplier: float = Field(gt=0, le=10000)
    budget_scope: str = Field(max_length=255)
    confirmed: bool
    reviewed_total: Optional[float] = Field(default=None, ge=0)


class BulkUploadCommitIn(BaseModel):
    project_site: str = Field(max_length=255)
    skip_existing: bool = True
    rows: List[BulkUploadItemRow] = Field(min_length=1, max_length=2000)
    preview_token: Optional[str] = Field(default=None, max_length=250000)
    sheet_checks: List[WorkbookSheetCheck] = Field(default_factory=list, max_length=2000)


class BulkUploadCommitOut(BaseModel):
    inserted_count: int
    created_codes: List[str]
    skipped: List[str] = []


class WorkbookItemPreview(BaseModel):
    name: str
    qty: Optional[float]
    unit: str
    unit_cost: Optional[float]
    category: str
    grp: str
    section: str
    section_matched: bool
    budget: str
    sheet_name: str
    row_number: int
    duplicate: bool = False
    warnings: List[str] = []
    errors: List[str] = []
    source_amount: Optional[float] = None
    excluded_by_default: bool = False


class WorkbookSheetPreview(BaseModel):
    sheet_name: str
    building_type: str
    building_type_confident: bool
    budget_number: Optional[int]
    budget_confident: bool
    item_count: int
    warnings: List[str] = []
    items: List[WorkbookItemPreview]
    budget_scope: str = ''
    suggested_multiplier: float = 1
    multiplier_evidence: str = ''
    source_total: Optional[float] = None
    source_total_cell: str = ''
    source_total_formula: str = ''
    source_total_label: str = ''
    summary_label: str = ''
    total_unreadable: bool = False
    requires_confirmation: bool = False


class WorkbookColumnMapping(BaseModel):
    header_row: int = Field(default=1, ge=0, le=10000)
    columns: Dict[str, int] = {}
    skip: bool = False


class WorkbookColumnPreview(BaseModel):
    index: int
    label: str


class WorkbookSampleRow(BaseModel):
    row_number: int
    cells: List[str]


class WorkbookLayoutPreview(BaseModel):
    sheet_name: str
    status: Literal['ready', 'needs_mapping', 'skipped']
    header_row: Optional[int]
    columns: List[WorkbookColumnPreview]
    sample_rows: List[WorkbookSampleRow]
    suggested_mapping: Dict[str, int]
    warnings: List[str] = []
    is_manual: bool = False
    hidden: bool = False


class WorkbookAnalyzeOut(BaseModel):
    file_name: str
    project_site: str
    sheet_count: int
    item_count: int
    duplicate_count: int
    sheets: List[WorkbookSheetPreview]
    layouts: List[WorkbookLayoutPreview] = []
    warnings: List[str] = []
    preview_token: str = ''


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
