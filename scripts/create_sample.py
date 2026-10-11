"""Create the bundled demo and a large-image integration fixture without network access."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
image = Image.new('RGB', (1200, 1000), '#f3eee5')
draw = ImageDraw.Draw(image)
draw.ellipse((380, 140, 840, 600), fill='#e3a47e')
draw.rounded_rectangle((240, 730, 960, 742), 6, fill='#303f34')
draw.line([(600, 725), (590, 520), (640, 300)], fill='#303f34', width=14)
draw.line([(593, 610), (440, 480), (390, 340)], fill='#303f34', width=10)
draw.line([(590, 580), (790, 490), (855, 380)], fill='#303f34', width=10)
for points in [((610, 480), (530, 350), (550, 220), (645, 310)),
               ((630, 380), (640, 210), (750, 170), (730, 300)),
               ((570, 640), (415, 650), (370, 560), (520, 550)),
               ((500, 525), (350, 510), (320, 400), (450, 425)),
               ((413, 410), (315, 330), (350, 220), (410, 290)),
               ((675, 540), (765, 390), (865, 350), (825, 500)),
               ((740, 510), (860, 500), (890, 580), (785, 600))]:
    draw.polygon(points, fill='#4a6652')
draw.ellipse((245, 220, 287, 262), fill='#b4a4d0')
draw.ellipse((895, 665, 925, 695), fill='#b4a4d0')
draw.line((260, 205, 270, 275), fill='#b4a4d0', width=3)
draw.line((235, 240, 300, 240), fill='#b4a4d0', width=3)
image.save(root / 'frontend' / 'sample.png', optimize=True)
print('Created frontend/sample.png')
