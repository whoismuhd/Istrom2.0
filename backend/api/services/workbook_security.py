"""Bound ZIP expansion and reject XML entities before opening Excel files."""
import io
from xml.parsers import expat
from zipfile import ZipFile, BadZipFile

MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_XML_BYTES = 32 * 1024 * 1024


def validate_workbook_archive(content: bytes):
    def reject_doctype(*args):
        raise ValueError("Excel XML must not contain document type declarations or entities.")

    try:
        with ZipFile(io.BytesIO(content)) as archive:
            entries = archive.infolist()
            if len(entries) > 2000 or len({entry.filename for entry in entries}) != len(entries):
                raise ValueError("Workbook archive contains too many or duplicate entries.")
            if sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES:
                raise ValueError("Workbook expands beyond the supported size. Split it into smaller files.")
            for entry in entries:
                if entry.file_size > MAX_XML_BYTES or entry.flag_bits & 1:
                    raise ValueError("Workbook contains an oversized or encrypted entry.")
                if entry.filename.lower().endswith((".xml", ".rels")):
                    parser = expat.ParserCreate()
                    parser.StartDoctypeDeclHandler = reject_doctype
                    with archive.open(entry) as stream:
                        while chunk := stream.read(65536):
                            parser.Parse(chunk, False)
                    parser.Parse(b"", True)
    except (BadZipFile, expat.ExpatError, RuntimeError) as exc:
        raise ValueError("This file is not a readable Excel workbook. Save it as .xlsx and try again.") from exc
