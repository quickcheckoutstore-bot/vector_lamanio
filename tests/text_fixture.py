import io
from PIL import Image, ImageDraw, ImageFont


def text_design():
    image = Image.new('RGB', (3200, 240), '#ffffff')
    draw = ImageDraw.Draw(image)
    draw.text((50, 40), 'Vectorio: crisp type 012345', font=ImageFont.load_default(size=24), fill='#202020')
    draw.text((50, 85), 'Small text: minimum detail, i.j! 012345', font=ImageFont.load_default(size=12), fill='#243855')
    draw.line((50, 112, 540, 112), fill='#243855', width=1)
    # Punctuation-sized isolated marks must survive noise filtering.
    draw.rectangle((50, 130, 51, 131), fill='#202020')
    draw.rectangle((60, 130, 61, 131), fill='#202020')
    out = io.BytesIO()
    image.save(out, format='PNG')
    return out.getvalue()
