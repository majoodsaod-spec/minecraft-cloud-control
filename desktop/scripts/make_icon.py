"""Generate small crisp native Windows installer icons from simple vector geometry.

The icon is rendered at CI build time, so the repository keeps only source code.
Requires Pillow. No proprietary fonts or downloaded artwork.
"""
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "src-tauri" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

S = 512
im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
draw = ImageDraw.Draw(im)
draw.rounded_rectangle((25, 25, S - 25, S - 25), radius=126, fill="#157961")
for y in range(45, 465):
    alpha = int(72 * (1 - y / 520))
    if alpha > 0:
        draw.line((75, y, 440, y), fill=(58, 206, 149, alpha), width=1)
# Top-down emerald crystal in a rounded app tile, minimal and legible at 16 px.
draw.polygon([(255, 103), (400, 185), (255, 269), (110, 185)], fill="#d8ffed")
draw.polygon([(110, 185), (255, 269), (255, 416), (110, 330)], fill="#b0edce")
draw.polygon([(400, 185), (255, 269), (255, 416), (400, 330)], fill="#ecfff4")
draw.line([(255, 269), (255, 416)], fill="#74cfa6", width=5)
draw.line([(110, 185), (255, 269), (400, 185)], fill="#75cfa7", width=5)
im.save(OUT / "icon.png", optimize=True)
im.save(OUT / "icon.ico", format="ICO", sizes=[
    (16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)
])
print("Generated Minecraft Cloud Windows icons")
