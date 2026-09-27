"""Draw the Control Room marketplace icon: a cartoon console, one big screen and three
chunky buttons. Drawn at 4x and downscaled, because PIL does not antialias strokes --
the scale-down is the antialiasing.

Palette is the room's own: cream ground, dark-brown ink, and the three pill colours the
panel already uses for ok / warn / err.
"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024                     # draw big
OUT = 256                    # ship 256x256 (the marketplace wants >=128)
CREAM = (242, 214, 180, 255)
INK = (43, 33, 24, 255)
SCREEN = (255, 244, 229, 255)
GREEN = (74, 145, 91, 255)
AMBER = (232, 168, 56, 255)
RED = (196, 78, 62, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
W = 26                                        # stroke, at 4x

# the ground: a rounded square, so the icon has a shape of its own on any backdrop
d.rounded_rectangle([12, 12, S - 12, S - 12], radius=190, fill=CREAM, outline=INK, width=W + 8)

# the aerial: pure cartoon, and the one thing that says "this listens"
d.line([512, 96, 512, 205], fill=INK, width=W)
d.ellipse([452, 40, 572, 160], fill=AMBER, outline=INK, width=W)

# the screen, with the panel's two columns drawn in it
d.rounded_rectangle([130, 200, S - 130, 630], radius=70, fill=SCREEN, outline=INK, width=W)
d.line([570, 200 + W // 2, 570, 630 - W // 2], fill=INK, width=W - 8)   # the column divider
for i, y in enumerate((300, 392, 484)):                                  # lines on the left
    d.rounded_rectangle([215, y, 215 + (255 if i < 2 else 165), y + 44], radius=22, fill=INK)
d.ellipse([650, 330, 810, 490], fill=GREEN, outline=INK, width=W - 6)    # the lamp, lit

# the desk: a slab under the screen, and the three big buttons that make it a console
d.rounded_rectangle([96, 690, S - 96, 872], radius=62, fill=CREAM, outline=INK, width=W)
for cx, col in ((268, GREEN), (512, AMBER), (756, RED)):
    d.ellipse([cx - 84, 697, cx + 84, 865], fill=col, outline=INK, width=W - 6)

# both extensions carry the same icon: one room, two surfaces
for out in ("extension/icon.png", "extension-sidebar/icon.png"):
    img.resize((OUT, OUT), Image.LANCZOS).save(Path(__file__).resolve().parent.parent / out)
print("wrote both icon.png at %dx%d" % (OUT, OUT))
