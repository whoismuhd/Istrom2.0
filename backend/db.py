"""Database configuration and session management."""
import os
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.engine import make_url

# Load backend/.env (or repo-root .env) so JWT_SECRET / DATABASE_URL can be set
# without exporting shell variables. db is the first module imported that reads
# env, so loading here covers api.dependencies too.
load_dotenv()
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

DATABASE_URL = os.getenv("DATABASE_URL") or "sqlite:///./istrominventory.db"
engine_options = {}
if make_url(DATABASE_URL).get_backend_name() == "sqlite":
    # File-backed SQLite needs independent connections for concurrent sessions.
    engine_options["connect_args"] = {"check_same_thread": False, "timeout": 30}
else:
    # Hosted databases can close idle connections or suspend their compute.
    # Check pooled connections before using them so the next request reconnects.
    engine_options["pool_pre_ping"] = True
engine = create_engine(DATABASE_URL, **engine_options)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
