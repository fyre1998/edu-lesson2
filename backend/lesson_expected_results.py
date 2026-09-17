"""Teacher-provided hypothetical bean results for the four-stage lesson."""

TREATMENT = 'bean_shading'
ASSETS = ('expected-tip.png', 'expected-neither.png', 'expected-lower.png')
LABELS = (
    'A、C、D 向光弯曲生长；B 无明显向光弯曲',
    'A、B、C、D 均向光弯曲生长',
    'A、B、C 向光弯曲生长；D 无明显向光弯曲',
)


def scenario(variant):
    return dict(treatment=TREATMENT, treatment_label='菜豆遮光实验预期结果', variant=variant,
                label=LABELS[variant], kind='假设性预期结果 · 非实测数据',
                control='A：完整幼苗；B：茎尖遮光；C：茎尖透明罩；D：茎尖以下遮光。均接受单侧蓝光。',
                boundary='这是教师提供的假设性预期结果，不是菜豆的真实实验数据。请根据本组图片讨论证据与解释。')
