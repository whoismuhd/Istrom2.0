"""SQLAlchemy models for Istrom Inventory Management System."""
from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from db import Base


class AccessCode(Base):
    __tablename__ = "access_codes"
    id = Column(Integer, primary_key=True, index=True)
    admin_code = Column(String(255), nullable=False)
    user_code = Column(String(255), nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow)
    updated_by = Column(String(255), nullable=True)


class ProjectSiteAccessCode(Base):
    __tablename__ = "project_site_access_codes"
    id = Column(Integer, primary_key=True, index=True)
    project_site = Column(String(255), nullable=False, unique=True)
    admin_code = Column(String(255), nullable=False)
    user_code = Column(String(255), nullable=False)
    # Retrievable copy for admin display; the bcrypt user_code above remains the
    # verification source of truth. Null for codes set before this column existed.
    user_code_plain = Column(String(255), nullable=True)
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
    full_name = Column(String(255), nullable=True)
    user_type = Column(String(50), nullable=False)  # admin, project_site
    project_site = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    is_active = Column(Boolean, default=True)


class Item(Base):
    __tablename__ = "items"
    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(100), nullable=True)
    name = Column(String(255), nullable=False)
    category = Column(String(50), nullable=False)  # materials, labour, Material/Labour
    unit = Column(String(50), nullable=False)
    qty = Column(Float, default=0)
    unit_cost = Column(Float, default=0)
    budget = Column(String(255), nullable=True)
    section = Column(String(255), nullable=True)
    grp = Column(String(255), nullable=True)
    building_type = Column(String(100), nullable=True)
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
    note = Column(Text, nullable=True)
    building_subtype = Column(String(100), nullable=True)
    status = Column(String(50), default="Pending")  # Pending, Approved, Rejected
    approved_by = Column(String(255), nullable=True)
    current_price = Column(Float, nullable=True)
    project_site = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    item = relationship("Item", backref="requests")


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


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    id = Column(Integer, primary_key=True, index=True)
    endpoint = Column(Text, nullable=False, unique=True)
    p256dh = Column(String(255), nullable=False)
    auth = Column(String(255), nullable=False)
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
