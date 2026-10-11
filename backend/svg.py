import xml.etree.ElementTree as ET
import re
import math

NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)


class TraceComplexityError(ValueError):
    """A valid trace exceeded the editor's resource budget."""


def pack_fragments(root, paths, max_paths):
    """Pack tiny disjoint cutout faces; retain large regions as individual shapes.

    VTracer with optimize=0 emits absolute M/L/C/Z paths without transforms.
    Only accept that known format. No contour, fill or pixel is discarded.
    """
    fragments = {}
    for element in paths:
        data = element.get('d', '')
        if element.get('transform') or re.search(r'[a-zA-Z]', re.sub(r'[MLCZ]', '', data)):
            continue
        values = [float(n) for n in re.findall(r'-?\d+(?:\.\d+)?', data)]
        if not values or len(values) % 2:
            continue
        xs, ys = values[::2], values[1::2]
        if max(xs) - min(xs) <= 8 and max(ys) - min(ys) <= 8:
            fragments[element] = (min(xs), min(ys))
    for tile in (128, 256, 512, 1024, None):
        groups = {}
        packed = []
        for element in paths:
            if element not in fragments:
                packed.append(element)
                continue
            x, y = fragments[element]
            position = (math.floor(x / tile), math.floor(y / tile)) if tile else ()
            key = (element.get('fill'), element.get('fill-rule'), position)
            if key not in groups:
                replacement = ET.Element(element.tag, {k: v for k, v in element.attrib.items() if k != 'id'})
                groups[key] = [replacement, [element.get('d', '')]]
                packed.append(replacement)
            else:
                groups[key][1].append(element.get('d', ''))
        if len(packed) <= max_paths:
            for replacement, pieces in groups.values():
                replacement.set('d', ' '.join(pieces))
            for element in paths:
                root.remove(element)
            root.extend(packed)
            return packed
    return paths


def normalize(path, width, height, max_paths):
    tree = ET.parse(path)
    root = tree.getroot()
    tw, th = int(root.attrib['width']), int(root.attrib['height'])
    root.set('viewBox', f'0 0 {tw} {th}')
    root.set('width', str(width))
    root.set('height', str(height))
    root.set('data-trace-width', str(tw))
    root.set('data-trace-height', str(th))
    paths = root.findall(f'{{{NS}}}path')
    original_paths = len(paths)
    if original_paths > max_paths:
        paths = pack_fragments(root, paths, max_paths)
    if len(paths) > max_paths:
        raise TraceComplexityError(f'The trace contains {len(paths):,} shapes; the editor limit is {max_paths:,}. Try the Illustrations profile or reduce color precision.')
    palette = {}
    for i, element in enumerate(paths):
        element.set('id', f'shape-{i}')
        color = element.get('fill', '#000000').lower()
        palette[color] = palette.get(color, 0) + 1
    tree.write(path, encoding='utf-8', xml_declaration=True)
    return {'width': width, 'height': height, 'trace_width': tw, 'trace_height': th,
            'paths': len(paths), 'palette': palette,
            'original_paths': original_paths, 'fragments_grouped': len(paths) < original_paths}


def render(path, edits):
    root = ET.parse(path).getroot()
    deleted = set(edits.get('deleted', []))
    fills = edits.get('fills', {})
    for element in list(root):
        shape_id = element.get('id')
        if shape_id in deleted:
            root.remove(element)
        elif shape_id in fills:
            element.set('fill', fills[shape_id])
    if edits.get('crop'):
        x, y, w, h = edits['crop']
        root.set('viewBox', f'{x} {y} {w} {h}')
        scale_x = float(root.get('width')) / float(root.get('data-trace-width'))
        scale_y = float(root.get('height')) / float(root.get('data-trace-height'))
        root.set('width', str(round(w * scale_x, 2)))
        root.set('height', str(round(h * scale_y, 2)))
    for key in ('data-trace-width', 'data-trace-height'):
        root.attrib.pop(key, None)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)
