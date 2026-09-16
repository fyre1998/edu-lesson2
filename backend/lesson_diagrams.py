"""Qualitative teaching diagrams, deliberately labelled as hypothetical."""
from html import escape
from .lesson_content import scenario


def result_svg(treatment, variant):
    s = scenario(treatment, variant)
    if treatment == 'marking':
        return marking_svg(s, variant)
    bent = (treatment == 'lower_shade' and variant == 0) or (treatment in {'remove_tip', 'tip_shade'} and variant == 1) or (treatment == 'marking' and variant < 2)
    weak = variant == 2

    def plant(cx, control=False):
        curve = control or bent
        short = weak and not control
        top_x, top_y = (cx-66, 155) if curve else (cx, 232 if short else 155)
        stem = f'M {cx} 345 Q {cx+12} 230 {top_x} {top_y}'
        leaves = f'<path d="M {cx} 315 Q {cx-70} 260 {cx-50} 302 Q {cx-20} 330 {cx} 315 M {cx} 315 Q {cx+70} 260 {cx+48} 302 Q {cx+20} 330 {cx} 315" fill="#5e9a77"/>'
        tip = f'<ellipse cx="{top_x}" cy="{top_y-3}" rx="8" ry="14" fill="#65b186"/>'
        if treatment == 'remove_tip' and not control:
            tip = f'<path d="M {top_x-10} {top_y} h 20" stroke="#ab6548" stroke-width="4"/>'
        if treatment == 'tip_shade' and not control:
            tip = f'<rect x="{top_x-13}" y="{top_y-22}" width="26" height="42" rx="6" fill="#263b50"/><text x="{top_x+23}" y="{top_y}" font-size="16">不透光帽</text>'
        extra = ''
        if treatment == 'lower_shade' and not control:
            extra = f'<rect x="{cx-27}" y="235" width="54" height="74" rx="5" fill="#263b50"/><text x="{cx+38}" y="270" font-size="16">下部遮光</text>'
        if treatment == 'marking' and not control:
            if weak:
                extra = f'<text x="{cx+22}" y="248" fill="#976313" font-size="18">标记不清晰</text>'
            else:
                y0 = 258 if variant == 0 else 177
                extra = ''.join(f'<path d="M {cx-13-int((280-y)/3)} {y} h 28" stroke="#173555" stroke-width="3"/>' for y in [y0, y0+17, y0+43])
                extra += f'<text x="{cx+32}" y="{y0+23}" font-size="16">间距变化</text>'
        return f'<path d="M {cx-105} 349 H {cx+115}" stroke="#ad9279" stroke-width="3"/><path d="{stem}" fill="none" stroke="#28735c" stroke-width="12" stroke-linecap="round"/>{leaves}{tip}{extra}'

    title = escape(s['label'])
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="980" height="480" viewBox="0 0 980 480" role="img" aria-label="假设情境：{title}">
<rect width="980" height="480" rx="16" fill="#f4f8fc"/>
<g font-family="Microsoft YaHei, sans-serif" fill="#173555">
<text x="28" y="40" font-size="23" font-weight="bold">假设情境／预期结果</text>
<text x="28" y="70" font-size="16" fill="#5e6e81">定性示意，不是菜豆实测数据；比较相同观察时段的表现</text>
<path d="M 490 95 V 375" stroke="#cedae5"/>
<text x="95" y="113" font-size="21">完整植株对照</text><text x="587" y="113" font-size="21">{escape(s['treatment_label'])}</text>
<g stroke="#418cf0" fill="#418cf0" stroke-width="3"><path d="M 48 190 h 80 m -13 -8 l 13 8 -13 8 M 536 190 h 70 m -13 -8 l 13 8 -13 8"/></g>
<text x="45" y="223" font-size="16" fill="#3978bd">单侧蓝光</text><text x="530" y="223" font-size="16" fill="#3978bd">单侧蓝光</text>
{plant(282, True)}{plant(745)}
<text x="84" y="391" font-size="18">出现伸长与向光弯曲</text>
<text x="28" y="436" font-size="21" font-weight="bold">实验处理的假设表现：{title}</text>
<text x="28" y="466" font-size="16" fill="#5e6e81">请结合对照，说明这个情境支持什么、不能确定什么。</text></g></svg>'''


def marking_svg(s, variant):
    """Unrolled edge marks show relative spacing, without inventing measured values."""
    def segment(x, y, changed=False, blurred=False):
        pieces = [f'<rect x="{x}" y="{y}" width="160" height="100" rx="9" fill="#dfede3"/>']
        for side, dx in enumerate((30, 125)):
            offsets = (15, 35, 55) if not changed or side == 0 else (15, 49, 83)
            if blurred:
                pieces.append(f'<text x="{x+dx}" y="{y+53}" text-anchor="middle" font-size="24" fill="#9a713d">?</text>')
            else:
                for offset in offsets:
                    pieces.append(f'<path d="M {x+dx-9} {y+offset} h 18" stroke="#256353" stroke-width="4"/>')
        return ''.join(pieces)
    body = ''
    for col, x in enumerate((210, 640)):
        body += f'<text x="{x}" y="148" font-size="19">受光侧　　背光侧</text>'
        for row, y in enumerate((175, 307)):
            body += f'<text x="{x-90}" y="{y+52}" font-size="19">{"上部" if row == 0 else "下部"}一段</text>'
            body += segment(x, y, col == 1 and row == (1 if variant == 0 else 0), col == 1 and variant == 2)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="980" height="560" viewBox="0 0 980 560" role="img" aria-label="假设情境：{escape(s['label'])}">
<rect width="980" height="560" rx="16" fill="#f4f8fc"/><g font-family="Microsoft YaHei,sans-serif" fill="#173555">
<text x="28" y="40" font-size="23" font-weight="bold">假设情境／预期结果 · 分段标记观察</text>
<text x="28" y="72" font-size="16">把茎两侧的标记展开对比；仅表示相对间距，不是实测数值</text>
<text x="205" y="112" font-size="22">观察开始：等距标记</text><text x="630" y="112" font-size="22">相同时间后</text>
<path d="M 490 100 V 420" stroke="#cedae5"/>{body}
<text x="28" y="458" font-size="20" font-weight="bold">{escape(s['label'])}</text>
<text x="28" y="491" font-size="17">共同条件：相同单侧蓝光；完整植株对照出现伸长与向光弯曲。</text>
<text x="28" y="527" font-size="16" fill="#5e6e81">仅供推理练习，不是菜豆的真实实验数据。请说明可定位的部位与证据局限。</text></g></svg>'''
