"""SQLAlchemy models for Istrom Inventory Management System."""
from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, ForeignKey, Text, Index, UniqueConstraint
from sqlalchemy.orm import relationship
from db import Base


class AccessCode(Base):
    __tablename__ = "access_codes"
    id = Column(Integer, primary_key=True, index=True)
    admin_code = Column(String(255), nullable=False)
    user_code = Column(String(255), nullable=False)
    session_version = Column(Integer, nullable=False, default=1)
    updated_at = Column(DateTime, default=datetime.utcnow)
    updated_by = Column(String(255), nullable=True)


class ProjectSiteAccessCode(Base):
    __tablename__ = "project_site_access_codes"
    id = Column(Integer, primary_key=True, index=True)
    project_site = Column(String(255), nullable=False, unique=True)
    admin_code = Column(String(255), nullable=False)
    user_code = Column(String(255), nullable=False)
    session_version = Column(Integer, nullable=False, default=1)
    # Encrypted copy for admin display; the bcrypt user_code above remains the
    # verification source of truth. Null for codes set before this column existed.
    user_code_plain = Column(Text, nullable=True)  # Legacy column name retained.
    updated_at = Column(DateTime, default=datetime.utcnow)


class ProjectSite(Base):
    __tablename__ = "project_sites"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    is_active = Column(Boolean, default=True)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(255), nullable=False)
    # Legacy rows are retained for history; only accounts with a login name
    # and password can sign in. Nullable uniqueness supports that migration.
    login_name = Column(String(255), nullable=True, unique=True)
    password_hash = Column(Text, nullable=True)
    session_version = Column(Integer, nullable=False, default=1)
    must_change_password = Column(Boolean, nullable=False, default=True)
    last_login_at = Column(DateTime, nullable=True)
    # Retained for historical accounts; current accounts use only usernames.
    full_name = Column(String(255), nullable=True)
    user_type = Column(String(50), nullable=False)  # admin, project_site
    project_site = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    is_active = Column(Boolean, default=True)


class AdminPasswordReset(Base):
    __tablename__ = 'admin_password_resets'
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True)
    recipient_hash = Column(String(64), nullable=False)
    session_version = Column(Integer, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)


class CreationReceipt(Base):
    __tablename__ = 'creation_receipts'
    __table_args__ = (UniqueConstraint('owner', 'operation', 'submission_key', name='ux_creation_receipt_intent'),)
    id = Column(Integer, primary_key=True)
    owner = Column(String(512), nullable=False)
    operation = Column(String(30), nullable=False)
    submission_key = Column(String(100), nullable=False)
    payload_hash = Column(String(64), nullable=False)
    record_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class Item(Base):
    __tablename__ = "items"
    __table_args__ = (Index('ux_items_import_key', 'import_key', unique=True),)
    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(100), nullable=True)
    name = Column(String(255), nullable=False)
    category = Column(String(50), nullable=False)  # materials, labour, Material/Labour
    unit = Column(String(50), nullable=False)
    qty = Column(Float, default=0)
    unit_cost = Column(Float, default=0)
    planned_qty = Column(Float, nullable=False, default=lambda ctx: ctx.get_current_parameters().get("qty", 0))
    planned_unit_cost = Column(Float, nullable=False, default=lambda ctx: ctx.get_current_parameters().get("unit_cost", 0))
    budget = Column(String(255), nullable=True)
    section = Column(String(255), nullable=True)
    grp = Column(String(255), nullable=True)
    building_type = Column(String(100), nullable=True)
    budget_scope = Column(String(255), nullable=True)
    source_sheet = Column(String(255), nullable=True)
    source_row = Column(Integer, nullable=True)
    import_key = Column(String(64), nullable=True)
    project_site = Column(String(255), default="Lifecamp Kafe")
    created_at = Column(DateTime, default=datetime.utcnow)


class Request(Base):
    __tablename__ = "requests"
    id = Column(Integer, primary_key=True, index=True)
    ts = Column(DateTime, default=datetime.utcnow)
    section = Column(String(50), nullable=True)  # materials, labour
    item_id = Column(Integer, ForeignKey("items.id"), nullable=False)
    qty = Column(Float, nullable=False)
    requested_by = Column(String(255), nullable=False)
    requested_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    approved_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    note = Column(Text, nullable=True)
    building_subtype = Column(String(100), nullable=True)
    status = Column(String(50), default="Pending")  # Pending, Approved, Rejected
    approved_by = Column(String(255), nullable=True)
    approved_shortage_qty = Column(Float, nullable=False, default=0, server_default="0")
    current_price = Column(Float, nullable=True)
    project_site = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    item = relationship("Item", backref="requests")

    @property
    def item_budget_scope(self):
        return self.item.budget_scope if self.item else None


class Notification(Base):
    __tablename__ = "notifications"
    id = Column(Integer, primary_key=True, index=True)
    notification_type = Column(String(50), nullable=False)
    title = Column(String(255), nullable=False)
    message = Column(Text, nullable=True)
    item_name = Column(String(255), nullable=True)
    qty = Column(Float, nullable=True)
    budget = Column(String(255), nullable=True)
    building_subtype = Column(String(100), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    request_id = Column(Integer, ForeignKey("requests.id"), nullable=True)
    project_site = Column(String(255), nullable=True)
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class NotificationRead(Base):
    __tablename__ = 'notification_reads'
    notification_id = Column(Integer, ForeignKey('notifications.id'), primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), primary_key=True)
    read_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    id = Column(Integer, primary_key=True, index=True)
    endpoint = Column(Text, nullable=False, unique=True)
    p256dh = Column(String(255), nullable=False)
    auth = Column(String(255), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    # Role snapshot from the subscriber's token, used to target pushes with the
    # same visibility rules as in-app notifications.
    user_type = Column(String(50), nullable=True)
    project_site = Column(String(255), nullable=True)
    is_global_admin = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class AccessLog(Base):
    __tablename__ = "access_logs"
    id = Column(Integer, primary_key=True, index=True)
    access_code = Column(String(255), nullable=True)
    user_name = Column(String(255), nullable=True)
    access_time = Column(DateTime, default=datetime.utcnow)
    success = Column(Boolean, default=False)
    role = Column(String(50), nullable=True)  # admin, project_site, unknown


class Actual(Base):
    __tablename__ = "actuals"
    id = Column(Integer, primary_key=True, index=True)
    item_id = Column(Integer, ForeignKey("items.id"), nullable=False)
    request_id = Column(Integer, ForeignKey("requests.id"), nullable=True)  # Links to request if auto-created on approve
    actual_qty = Column(Float, nullable=False)
    actual_cost = Column(Float, nullable=False)
    actual_date = Column(DateTime, nullable=False)
    recorded_by = Column(String(255), nullable=False)
    notes = Column(Text, nullable=True)
    building_subtype = Column(String(100), nullable=True)
    project_site = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    item = relationship("Item", backref="actuals")


class DeletedRequest(Base):
    __tablename__ = "deleted_requests"
    id = Column(Integer, primary_key=True, index=True)
    req_id = Column(Integer, nullable=False)
    item_name = Column(String(255), nullable=True)
    qty = Column(Float, nullable=True)
    requested_by = Column(String(255), nullable=True)
    budget = Column(String(255), nullable=True)
    building_subtype = Column(String(100), nullable=True)
    status = Column(String(50), nullable=True)
    deleted_at = Column(DateTime, default=datetime.utcnow)
    deleted_by = Column(String(255), nullable=True)
    project_site = Column(String(255), nullable=True)
