"""Bound ZIP expansion and reject XML entities before opening Excel files."""
import io
import posixpath
from xml.etree import ElementTree
from xml.parsers import expat
from zipfile import ZipFile, BadZipFile
from openpyxl.utils.cell import range_boundaries

MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_XML_BYTES = 32 * 1024 * 1024


def workbook_merges(content):
    """Read only declared merge ranges after archive validation."""
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    relation_key = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
    result = {}
    merged_cells = 0
    with ZipFile(io.BytesIO(content)) as archive:
        relations = ElementTree.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        paths = {rel.get('Id'): rel.get('Target') for rel in relations if rel.get('TargetMode') != 'External'}
        book = ElementTree.fromstring(archive.read('xl/workbook.xml'))
        for sheet in book.findall('s:sheets/s:sheet', ns):
            target = paths.get(sheet.get(relation_key), '')
            path = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
            ranges = []
            if path not in archive.namelist():
                continue
            with archive.open(path) as stream:
                for _, element in ElementTree.iterparse(stream, events=('end',)):
                    if element.tag.endswith('}mergeCell'):
                        bounds = range_boundaries(element.get('ref', ''))
                        if None in bounds or not (1 <= bounds[0] <= bounds[2] <= 100 and 1 <= bounds[1] <= bounds[3] <= 10000):
                            raise ValueError('Workbook contains a merge outside the supported range.')
                        ranges.append(bounds)
                        merged_cells += (bounds[2] - bounds[0] + 1) * (bounds[3] - bounds[1] + 1)
                        if merged_cells > 2000000:
                            raise ValueError('Workbook contains too many merged cells.')
                        if len(ranges) > 50000:
                            raise ValueError('Workbook contains too many merged cells.')
                    element.clear()
            result[sheet.get('name')] = ranges
    return result


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
