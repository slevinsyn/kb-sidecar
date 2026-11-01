#!/usr/bin/env python3
"""Turn a knowledge base article written in Markdown into a branded Word file.

  kba_docx.py changes/<change>/kba/kba.md  [--out kba.docx]

Standard library only (no python-docx needed). Understands the Markdown the kba-writer
produces: # title, ## / ### headings, paragraphs, - bullets, 1. numbered lines, > notes,
``` code blocks, | tables | (first row = header) and ![caption](screenshots/x.png) images,
also inside table cells. Colours and font follow Waddaya's Lumina tokens; set
`kba_logo` (a PNG path in the repository) in .phased/config.json to put the logo on top.
"""
import re
import struct
import sys
import zipfile
sys.dont_write_bytecode = True
from pathlib import Path
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

PRIMARY, DEEP, ERROR, TERTIARY, SOFT, CODEBG = "4343D5", "07006C", "BA1A1A", "006279", "EEEEFB", "F3F3F8"
FONT, MONO = "Hanken Grotesk", "Consolas"
EMU = 914400

W_NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"')


class Doc:
    def __init__(self, base):
        self.base = base
        self.body = []
        self.media = []  # (zip name, bytes)
        self.rels = []   # (rId, target)

    # ---------------------------------------------------------------- images
    def image(self, path, max_in):
        p = (self.base / path) if not Path(path).is_absolute() else Path(path)
        if not p.is_file() or p.suffix.lower() not in (".png", ".jpg", ".jpeg"):
            return self.run(f"[missing image: {path}]", color=ERROR, italic=True)
        data = p.read_bytes()
        w, h = 1600, 900
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            w, h = struct.unpack(">II", data[16:24])
        n = len(self.media) + 1
        ext = "png" if data[:4] == b"\x89PNG" else "jpeg"
        name = f"media/image{n}.{ext}"
        rid = f"rIdImg{n}"
        self.media.append((name, data))
        self.rels.append((rid, name))
        cx = int(max_in * EMU)
        cy = int(cx * h / max(w, 1))
        if cy > int(7.5 * EMU):
            cy = int(7.5 * EMU)
            cx = int(cy * w / max(h, 1))
        return (f'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/>'
                f'<wp:docPr id="{n}" name="Picture {n}"/><a:graphic><a:graphicData '
                f'uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr>'
                f'<pic:cNvPr id="{n}" name="image{n}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill>'
                f'<a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr>'
                f'<a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect">'
                f'<a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>')

    # ---------------------------------------------------------------- text
    @staticmethod
    def run(text, bold=False, italic=False, color=None, mono=False, size=None):
        props = ""
        if mono:
            props += f'<w:rFonts w:ascii="{MONO}" w:hAnsi="{MONO}" w:cs="{MONO}"/>'
        if bold:
            props += "<w:b/>"
        if italic:
            props += "<w:i/>"
        if color:
            props += f'<w:color w:val="{color}"/>'
        if size:
            props += f'<w:sz w:val="{size}"/>'
        return f'<w:r><w:rPr>{props}</w:rPr><w:t xml:space="preserve">{escape(text)}</w:t></w:r>'

    def inline(self, text, max_in=6.0, color=None):
        """**bold**, *italic*, `code` and ![caption](path) inside one line."""
        out = []
        for part in re.split(r"(!\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)", text):
            if not part:
                continue
            m = re.fullmatch(r"!\[([^\]]*)\]\(([^)]+)\)", part)
            if m:
                out.append(self.image(m.group(2).strip(), max_in))
                if m.group(1):
                    out.append(f'<w:r><w:br/></w:r>{self.run(m.group(1), italic=True, color=TERTIARY, size=18)}')
            elif part.startswith("**") and part.endswith("**"):
                out.append(self.run(part[2:-2], bold=True, color=color))
            elif part.startswith("`") and part.endswith("`"):
                out.append(self.run(part[1:-1], mono=True, color=DEEP))
            elif part.startswith("*") and part.endswith("*") and len(part) > 2:
                out.append(self.run(part[1:-1], italic=True, color=color))
            else:
                out.append(self.run(part, color=color))
        return "".join(out)

    def para(self, runs, style=None, shade=None, indent=None, keep=False):
        ppr = ""
        if style:
            ppr += f'<w:pStyle w:val="{style}"/>'
        if keep:
            ppr += "<w:keepNext/>"
        if shade:
            ppr += f'<w:shd w:val="clear" w:color="auto" w:fill="{shade}"/>'
        if indent:
            ppr += f'<w:ind w:left="{indent}" w:hanging="240"/>'
        self.body.append(f"<w:p><w:pPr>{ppr}</w:pPr>{runs}</w:p>")

    def table(self, rows):
        cols = max(len(r) for r in rows)
        total = 9600
        widths = [total // cols] * cols
        if cols >= 3:  # give long text columns more room
            lens = [max(len(r[i]) if i < len(r) else 0 for r in rows) for i in range(cols)]
            s = sum(min(x, 60) + 6 for x in lens)
            widths = [int(total * (min(x, 60) + 6) / s) for x in lens]
        xml = ['<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>'
               + "".join(f'<w:{b} w:val="single" w:sz="4" w:space="0" w:color="C9C9E8"/>'
                         for b in ("top", "left", "bottom", "right", "insideH", "insideV"))
               + '</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>'
               '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>'
               + "".join(f'<w:gridCol w:w="{w}"/>' for w in widths) + "</w:tblGrid>"]
        for i, r in enumerate(rows):
            xml.append('<w:tr><w:trPr><w:cantSplit/>' + ('<w:tblHeader/>' if i == 0 else '') + '</w:trPr>')
            for j in range(cols):
                cell = r[j] if j < len(r) else ""
                shade = f'<w:shd w:val="clear" w:color="auto" w:fill="{PRIMARY}"/>' if i == 0 else (
                    f'<w:shd w:val="clear" w:color="auto" w:fill="{SOFT}"/>' if i % 2 == 0 else "")
                max_in = max(1.2, 6.5 * widths[j] / total - 0.15)
                runs = (self.run(cell.replace("**", ""), bold=True, color="FFFFFF") if i == 0
                        else self.inline(cell, max_in=max_in))
                xml.append(f'<w:tc><w:tcPr><w:tcW w:w="{widths[j]}" w:type="dxa"/>{shade}</w:tcPr>'
                           f'<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>{runs}</w:p></w:tc>')
            xml.append("</w:tr>")
        xml.append("</w:tbl>")
        self.body.append("".join(xml))
        self.para("")

    # ---------------------------------------------------------------- markdown
    def markdown(self, text):
        lines = re.sub(r"<!--.*?-->", "", text, flags=re.S).splitlines()
        i = 0
        while i < len(lines):
            line = lines[i].rstrip()
            if line.startswith("```"):
                i += 1
                while i < len(lines) and not lines[i].startswith("```"):
                    self.para(self.run(lines[i], mono=True, size=18), shade=CODEBG)
                    i += 1
                i += 1
                continue
            if line.startswith("|"):
                rows = []
                while i < len(lines) and lines[i].strip().startswith("|"):
                    cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                    if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                        rows.append(cells)
                    i += 1
                if rows:
                    self.table(rows)
                continue
            if not line.strip() or line.strip() == "---":
                i += 1
                continue
            m = re.match(r"^(#{1,3})\s+(.*)$", line)
            if m:
                level = len(m.group(1))
                style = {1: "Title", 2: "Heading1", 3: "Heading2"}[level]
                color = ERROR if re.search(r"(?i)error|problem|issue", m.group(2)) and level > 1 else None
                self.para(self.inline(m.group(2), color=color), style=style, keep=True)
            elif re.match(r"^\s*[-*]\s+", line):
                self.para(self.run("•  ", color=PRIMARY, bold=True) + self.inline(re.sub(r"^\s*[-*]\s+", "", line)), indent=360)
            elif line.startswith(">"):
                self.para(self.inline(line.lstrip("> ").strip(), color=TERTIARY), shade=SOFT)
            else:
                self.para(self.inline(line))
            i += 1

    # ---------------------------------------------------------------- package
    def save(self, out, title):
        styles = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles {W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:cs="{FONT}" w:eastAsia="{FONT}"/>
<w:sz w:val="21"/><w:color w:val="1F1F2E"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="200"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="{PRIMARY}"/></w:pBdr></w:pPr><w:rPr><w:b/><w:color w:val="{DEEP}"/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="{PRIMARY}"/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="{TERTIARY}"/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>'''
        sect = ('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" '
                'w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>')
        document = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W_NS}><w:body>'
                    + "".join(self.body) + sect + "</w:body></w:document>")
        rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships '
                'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
                + "".join(f'<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{t}"/>'
                          for rid, t in self.rels) + "</Relationships>")
        types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                 '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                 '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
                 '<Default Extension="jpeg" ContentType="image/jpeg"/>'
                 '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                 '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                 '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>')
        root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                     '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                     '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>')
        core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties '
                'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
                'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + escape(title) + '</dc:title>'
                '<dc:creator>Waddaya Solutions</dc:creator></cp:coreProperties>')
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("[Content_Types].xml", types)
            z.writestr("_rels/.rels", root_rels)
            z.writestr("docProps/core.xml", core)
            z.writestr("word/document.xml", document)
            z.writestr("word/styles.xml", styles)
            z.writestr("word/_rels/document.xml.rels", rels)
            for name, data in self.media:
                z.writestr("word/" + name, data)


def main(argv):
    if len(argv) < 2:
        C.say(__doc__)
        return 2
    md = Path(argv[1])
    if not md.is_file():
        C.say(f"kba_docx: {md} not found.", sys.stderr)
        return 1
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else md.with_suffix(".docx")
    root = C.find_root(str(md.resolve().parent))
    cfg = C.load_config(root) or {}
    doc = Doc(md.resolve().parent)
    logo = cfg.get("kba_logo")
    if logo and Path(root, logo).is_file():
        doc.para(doc.image(str(Path(root, logo)), 1.6))
    text = md.read_text(encoding="utf-8")
    doc.markdown(text)
    m = re.search(r"^#\s+(.+)$", text, flags=re.M)
    doc.save(out, m.group(1).strip() if m else md.stem)
    C.say(f"Word file written: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
