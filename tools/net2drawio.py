"""
Converts a network file of the Java traffic simulation (.net) to a .drawio
file for the traffic simulation, with the rules and styles of its Import:
crossings are 16x16 asphalt ellipses centered on the node coordinates
(1 unit = 1 m), links in both directions become one road (shape=road)
without arrows, the others one-way roads with an arrow. Plans are ignored.
--flip mirrors the y-axis so that geographic coordinates (north up) are
shown with north at the top.

Cell IDs keep the IDs of the file: n<node> for crossings, e<link> for
one-way roads and e<link>-<reverse link> for roads in both directions.

Usage: python3 -I net2drawio.py [--flip] [--name NAME] input.net output.drawio
"""
import sys
from xml.sax.saxutils import quoteattr

SIZE = 16
CROSSING = 'ellipse;aspect=fixed;resizeCentered=1;strokeColor=none;fillColor=light-dark(#5f6368,#5f6368);'
ONE_WAY = 'shape=road;endArrow=block;strokeWidth=7;'
TWO_WAY = 'shape=road;endArrow=none;startArrow=none;strokeWidth=14;'


def parse(path):
    nodes = {}
    edges = []
    section = None

    with open(path, encoding='latin-1') as f:
        for line in f:
            line = line.strip()

            if line.startswith('['):
                section = line
            elif line:
                tokens = line.split(',')

                if section == '[Nodes]' and len(tokens) >= 3:
                    nodes[tokens[0]] = (float(tokens[1]), float(tokens[2]))
                elif section == '[Edges]' and len(tokens) >= 3:
                    edges.append((tokens[0], tokens[1], tokens[2]))

    return nodes, edges


def convert(nodes, edges, flip, name):
    min_x = min(p[0] for p in nodes.values())
    min_y = min(p[1] for p in nodes.values())
    max_y = max(p[1] for p in nodes.values())
    out = ['<mxfile host="drawio"><diagram id="net" name=%s>' % quoteattr(name),
        '<mxGraphModel grid="0" gridSize="10" guides="1" tooltips="1" connect="1" '
        'arrows="1" fold="1" page="0" pageScale="1" pageWidth="850" pageHeight="1100" '
        'math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>']

    for id, (x, y) in nodes.items():
        y = (max_y - y) if flip else (y - min_y)
        out.append('<mxCell id=%s value="" style="%s" vertex="1" parent="1">'
            '<mxGeometry x="%.2f" y="%.2f" width="%d" height="%d" as="geometry"/></mxCell>' %
            (quoteattr('n' + id), CROSSING, x - min_x - SIZE / 2, y - SIZE / 2, SIZE, SIZE))

    links = {}

    for id, src, trg in edges:
        links.setdefault((src, trg), id)

    done = set()
    ids = set()
    one_way = two_way = 0

    for id, src, trg in edges:
        if src in nodes and trg in nodes and src != trg and (src, trg) not in done:
            reverse = links.get((trg, src))
            cell_id = 'e' + id + ('-' + reverse if reverse is not None else '')

            while cell_id in ids:
                cell_id += "'"

            ids.add(cell_id)
            done.add((src, trg))

            if reverse is not None:
                done.add((trg, src))
                two_way += 1
            else:
                one_way += 1

            out.append('<mxCell id=%s value="" style="%s" edge="1" parent="1" source=%s target=%s>'
                '<mxGeometry relative="1" as="geometry"/></mxCell>' % (quoteattr(cell_id),
                TWO_WAY if reverse is not None else ONE_WAY, quoteattr('n' + src), quoteattr('n' + trg)))

    out.append('</root></mxGraphModel></diagram></mxfile>')

    return '\n'.join(out), one_way, two_way


def main(args):
    flip = '--flip' in args
    args = [a for a in args if a != '--flip']
    name = 'Network'

    if '--name' in args:
        i = args.index('--name')
        name = args[i + 1]
        del args[i:i + 2]

    nodes, edges = parse(args[0])
    xml, one_way, two_way = convert(nodes, edges, flip, name)

    with open(args[1], 'w', encoding='utf-8') as f:
        f.write(xml)

    print('%d crossings, %d one-way and %d two-way roads -> %s' %
        (len(nodes), one_way, two_way, args[1]))


if __name__ == '__main__':
    main(sys.argv[1:])
