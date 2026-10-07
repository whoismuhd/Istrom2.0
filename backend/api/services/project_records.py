"""Keep project renames and record writes in the same transaction order."""
from fastapi import HTTPException
from sqlalchemy.exc import InvalidRequestError
from models import ProjectSite


def lock_project_records(db, project_site, record=None):
    """Lock the site before its items/requests; refresh records read before it."""
    if project_site:
        db.query(ProjectSite).filter(ProjectSite.name == project_site).update(
            {ProjectSite.is_active: ProjectSite.is_active}, synchronize_session=False)
    if record is not None:
        try:
            db.refresh(record)
        except InvalidRequestError as exc:
            db.rollback()
            raise HTTPException(409, 'This record was removed. Refresh and try again.') from exc
        if record.project_site != project_site:
            db.rollback()
            raise HTTPException(409, 'The project site changed. Refresh and try again.')
