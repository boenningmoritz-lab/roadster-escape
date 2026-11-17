#!/usr/bin/env python3
"""
Baut aus den Modulen (index.html, css/, js/) eine einzige, eigenständige HTML-Datei:
  python3 tools/bundle.py            → dist/roadster-escape.html
Praktisch zum Teilen als eine Datei (z. B. per Mail oder als Vorschau). Für die
Veröffentlichung im Web reicht der Ordner selbst – siehe README.
"""
import os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMP_LOCAL = re.compile(r"^import \{[^}]*\} from '(\.[^']+)';\n", re.M)
IMP_EXT = re.compile(r"^import .* from '(three[^']*)';\n", re.M)
EXPORT = re.compile(r"^export \{[^}]*\};\n", re.M)

def order(path, seen, out):
    path = os.path.normpath(path)
    if path in seen: return
    seen.add(path)
    src = open(path, encoding='utf-8').read()
    for rel in IMP_LOCAL.findall(src):
        order(os.path.join(os.path.dirname(path), rel), seen, out)
    out.append(path)

def main():
    mods = []
    order(os.path.join(ROOT, 'js', 'main.js'), set(), mods)
    ext, body = [], []
    for m in mods:
        src = open(m, encoding='utf-8').read()
        for line in IMP_EXT.finditer(src):
            if line.group(0) not in ext: ext.append(line.group(0))
        src = IMP_EXT.sub('', IMP_LOCAL.sub('', src))
        src = EXPORT.sub('', src)
        body.append(f'// ---- {os.path.relpath(m, ROOT)} ----\n' + src.strip() + '\n')
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    css = open(os.path.join(ROOT, 'css', 'style.css'), encoding='utf-8').read()
    html = html.replace('<link rel="stylesheet" href="css/style.css">', '<style>\n' + css + '</style>')
    html = re.sub(r'<link rel="(manifest|apple-touch-icon|icon)"[^>]*>\n', '', html)
    script = '<script type="module">\n' + ''.join(ext) + '\n' + '\n'.join(body) + '</script>'
    html = html.replace('<script type="module" src="js/main.js"></script>', script)
    os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
    out = os.path.join(ROOT, 'dist', 'roadster-escape.html')
    open(out, 'w', encoding='utf-8').write(html)
    print(f'{out}: {len(mods)} Module, {len(html) // 1024} KB')

if __name__ == '__main__':
    main()
