"""Represent source pixels as editable SVG paths without a tracing approximation."""
from collections import defaultdict
from .svg import TraceComplexityError


def convert(image, destination, max_paths, max_bytes):
    width, height = image.size
    paths = defaultdict(list)
    size = 0
    pixels = image.load()
    for y in range(height):
        x = 0
        while x < width:
            color = pixels[x, y]
            end = x + 1
            while end < width and pixels[end, y] == color:
                end += 1
            if color[3]:
                # Integer, non-overlapping rectangles preserve even one-pixel marks.
                piece = f'M{x} {y}h{end-x}v1h{x-end}z'
                paths[color].append(piece)
                size += len(piece)
                if len(paths) > max_paths or size + len(paths) * 150 > max_bytes:
                    raise TraceComplexityError('Exact PNG exceeds the editor size or color limit. No detail was reduced. Use a smaller image or explicitly choose a smooth tracing profile.')
            x = end
    with open(destination, 'w', encoding='utf-8') as output:
        output.write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" shape-rendering="crispEdges">')
        for (r, g, b, a), pieces in paths.items():
            opacity = f' fill-opacity="{a/255:.9f}"' if a != 255 else ''
            output.write(f'<path fill="#{r:02x}{g:02x}{b:02x}"{opacity} d="{"".join(pieces)}"/>')
        output.write('</svg>')
