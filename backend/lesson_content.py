"""Reviewed, phase-gated classroom materials. Never expose this module as static files."""
from copy import deepcopy

TITLE = '蓝光怎样引起菜豆向光生长？'
SOURCE = '《生物学》选择性必修1《稳态与调节》第五章'
TREATMENTS = {
    'remove_tip': '去除顶端', 'tip_shade': '顶端遮光',
    'lower_shade': '下部遮光', 'marking': '分段标记观察', 'custom': '其他／自定义方案',
}


def field(key, label, placeholder='', required=True, options=None):
    return dict(key=key, label=label, placeholder=placeholder, required=required, options=options)


STAGES = {
    1: dict(title='发现问题', question='改变光，为什么改变了生长的方向？', minutes=4,
        task='比较菜豆在不同光照条件下的表现。把观察到的事实与自己的解释分开记录。',
        fields=[field('observation', '我们观察到的事实', '描述光照条件与菜豆的表现，不急于解释原因。'),
                field('hypothesis', '我们的初步解释', '蓝光可能怎样影响菜豆？这是我们的猜想……')],
        hints=['向光性：植物对定向光产生的定向生长反应。请先区分生长、弯曲与攀援。',
               '图中的支架、植物与光照分别是什么条件？哪些条件发生了改变？',
               '在……条件下，我们观察到……；我们猜想……；还需要检验……。'],
        prompts=['帮我们区分观察事实和解释', '我们的假说可以怎样检验？']),
    2: dict(title='设计检验', question='菜豆的感光部位与弯曲部位相同吗？', minutes=9,
        task='借鉴已有研究，设计一个菜豆实验。先记录预测，再根据分发的假设情境作出判断。',
        fields=[field('treatment', '主要处理', options=TREATMENTS),
                field('design', '处理、对照与观察指标', '写清遮光／去顶的部位、对照组及怎样判断生长和弯曲。'),
                field('prediction', '分发结果之前，我们的预测', '如果假说成立，实验组与对照组应该……；如果没有出现，则……'),
                field('conclusion', '根据假设结果，我们能得出什么？', '收到结果图后填写：在这个假设情境中……；仍不能确定……', required=False)],
        hints=['胚芽鞘包被禾本科幼苗的幼叶。菜豆有顶芽、幼叶和茎等结构，不能直接当成胚芽鞘。',
               '只比较“弯不弯”够吗？如果去顶后不再生长，能否仅凭不弯曲判断感光部位？',
               '实验组……；对照组……；保持……相同；连续记录……。不同结果分别意味着……。'],
        prompts=['检查我们的变量与对照', '这份预期结果能支持什么？']),
    3: dict(title='选择证据', question='这种影响怎样传递，又怎样造成弯曲？', minutes=12,
        task='从三个问题中选择本组要检验的问题。查阅研究方案，说明它能回答什么、不能回答什么。',
        fields=[field('research_question', '本组首先研究', options={
                    'growth': '这种影响是促进还是抑制生长？', 'nature': '这种影响的本质是什么？',
                    'light': '这种影响是光诱导后才产生的吗？'}),
                field('reference', '我们选择的研究支架', options={'jensen': '波森·詹森', 'boysen_bayer': '拜尔', 'both': '两组实验互补'}),
                field('design', '选择理由与本组改进方案', '我们选这个设计，是因为……；迁移到菜豆时准备……'),
                field('boundary', '能回答什么，还不能回答什么？', '能检验……；不能仅凭它判断……；还需要……')],
        hints=['可透过与不可透过的隔离材料，可以帮助研究尖端与下部之间的联系。偏置是改变位置而不是增加总量。',
               '实验改变的是材料、光照还是放置位置？哪一个问题与这个变量真正对应？',
               '我们要检验……；选择……处理；如果观察到……，则支持……；它仍不能说明……。'],
        prompts=['我们选择的实验能回答这个问题吗？', '这个解释还缺少哪一种对照？']),
    4: dict(title='分析结果', question='什么证据支持存在可转移的促生长物质？', minutes=8,
        task='直接分析温特实验的结果。将具体对照与结论相连，区分促进生长和造成弯曲。',
        fields=[field('evidence', '证据与结论的对应关系', '比较第……组与第……组，发现……，支持……。'),
                field('growth_bending', '有促生长物质，就一定会弯曲吗？', '用居中和偏置处理的结果说明。'),
                field('new_prediction', '如果把琼脂块换到另一侧', '我们预测……，理由是……。')],
        hints=['空白琼脂没有接触过尖端。处理琼脂指接触过尖端的琼脂；两者不能混淆。',
               '哪些对照排除了琼脂本身的作用？哪些对照涉及促生长作用在两侧是否均等？',
               '证据：……与……相比；解释：……；支持的结论：……；不能据此断言：……。'],
        prompts=['检查我们的证据是否支持结论', '帮我们区分生长和弯曲']),
    5: dict(title='建立模型', question='我们怎样解释蓝光导航，还需要怎样检验？', minutes=7,
        task='绘制本组的菜豆解释图并拍照上传。标出已有证据支持的认识、迁移到菜豆时的假设和下一步检验。',
        fields=[field('model', '用文字说明我们的解释图', '各环节怎样联系？箭头代表什么？可附上手绘图。'),
                field('supported', '已有证据与仍待检验的联系', '实线表示……，依据材料……；虚线表示……，还没有菜豆实验证据。'),
                field('next_test', '下一步如何检验', '如果模型成立，改变……应观察到……；否则需要重新检查……。')],
        hints=['解释模型可以产生预测。胚芽鞘实验的结论迁移到菜豆时，仍需要适合菜豆结构的实验。',
               '图里有没有从“看到弯曲”直接跳到“已证明生长素分布”？每一条箭头分别依据什么？',
               '标注已观察的事实、历史实验支持的认识、菜豆中的待检验联系，再提出一个可能推翻模型的结果。'],
        prompts=['检查解释图是否存在推理跳步', '哪一步最需要菜豆实验检验？']),
}

MATERIALS = [
    dict(id='navigation', stage=1, kind='情境观察', title='植物的蓝光导航',
         source='《生长素》课堂课件，第2页；图片为研究装置与现象截图',
         paragraphs=['支架提供可攀援的路径。比较不同光照条件下植物的表现，思考光的位置与生长方向的关系。',
                     '这些图片用于观察情境；单凭图片不能说明植物体内发生了什么。'],
         assets=['navigation-red.png', 'navigation-left.png', 'navigation-right.png'],
         captions=['红光条件下的装置截图', '蓝光位于左侧的情境截图', '蓝光位于右侧的情境截图']),
    dict(id='darwin', stage=2, kind='历史实验证据', title='达尔文父子的向光性研究',
         source=SOURCE+'，第98页图5-2；图来自课堂课件第4页',
         paragraphs=['比较完整幼苗、去顶、尖端不透光帽、尖端透明帽以及下部遮光等处理。',
                     '在图示条件下，完整幼苗、透明帽处理和下部遮光处理出现向光弯曲；去顶或尖端遮光处理未出现相应弯曲。',
                     '这些对照支持感光与弯曲发生在不同部位。对菜豆是否同样成立，需要重新设计实验。'],
         assets=['darwin.png'], captions=['达尔文实验的处理与结果示意']),
    dict(id='cells', stage=3, kind='机制示意', title='两侧伸长不同，可以怎样改变方向？',
         source='《生长素》课堂课件，第5页示意图',
         paragraphs=['比较图中受光侧与背光侧的细胞伸长。这里展示的是解释弯曲的一种示意，不是本组菜豆实验的测量结果。',
                     '接下来需要检验：这种差异怎样形成？'], assets=['cells.png'], captions=['两侧细胞伸长差异示意']),
    dict(id='jensen', stage=3, kind='历史研究方案', title='波森·詹森：改变尖端与下部之间的联系',
         source=SOURCE+'，第99页图5-3；本阶段暂不呈现结果',
         paragraphs=['在尖端与下部之间分别放入明胶和云母片，在相同的单侧光条件下比较。',
                     '明胶允许一些物质透过，云母片不易透过；需要保持材料活性与其余条件可比。',
                     '先预测不同结果的含义，并思考两种隔离材料是否还可能带来其他差异。'], assets=[], captions=[]),
    dict(id='bayer', stage=3, kind='历史研究方案', title='拜尔：在黑暗中改变尖端位置',
         source=SOURCE+'，第99页图5-4；本阶段暂不呈现结果',
         paragraphs=['切下胚芽鞘尖端，在黑暗条件下将尖端放回切口的一侧。',
                     '本组可以补充居中放回、无尖端等对照，比较伸长与弯曲，说明各组对照的用途。',
                     '思考：黑暗条件、偏置位置分别针对解释中的哪一个环节？'], assets=[], captions=[]),
    dict(id='research-results', stage=3, kind='历史实验证据', title='交流后的历史结果核对', gated=True,
         source=SOURCE+'，第99页图5-3、图5-4',
         paragraphs=['波森·詹森：明胶隔开的处理仍可向光弯曲，云母片隔开的处理不出现相应弯曲，支持可传递影响与可移动物质有关。',
                     '拜尔：黑暗中偏置尖端仍可引起弯曲，支持两侧作用不均与弯曲有关。',
                     '黑暗中出现弯曲，不能单凭这一点断定某种物质的产生在所有情况下都不需要光；这些实验也没有鉴定具体化学结构。'],
         assets=[], captions=[]),
    dict(id='went', stage=4, kind='历史实验证据', title='温特：将尖端的影响收集到琼脂中',
         source=SOURCE+'，第100页图5-5；下表为教学整理',
         paragraphs=['将尖端放在琼脂块上一段时间，再把琼脂放到去顶胚芽鞘的切口上。比较处理琼脂与空白琼脂，以及居中与偏置的结果。',
                     '温特的研究为存在可转移的促生长物质提供了证据，并将其命名为生长素。这不等于当时已经鉴定了该物质的化学结构。'],
         rows=[['去顶，不放琼脂', '没有尖端', '不出现相应的伸长'], ['空白琼脂居中或偏置', '未接触尖端', '不出现相应的伸长'],
               ['处理琼脂居中', '接触过尖端', '直立生长'], ['处理琼脂偏左', '接触过尖端', '向右弯曲生长'], ['处理琼脂偏右', '接触过尖端', '向左弯曲生长']],
         assets=['went.png'], captions=['温特实验，教材第100页图5-5']),
    dict(id='model', stage=5, kind='建模提示', title='把证据连接起来，也留下待检验的问题',
         source='本课建模任务',
         paragraphs=['本组解释图的标题写为“菜豆蓝光导航的待检验模型”。',
                     '用实线标出历史证据支持的认识，用虚线标出迁移到菜豆时仍待检验的联系。不要把假设情境中的结果当成真实实验数据。',
                     '菜豆与胚芽鞘材料不同；具体感光结构、生长区域及处理的影响，需要在菜豆中验证。'], assets=[], captions=[]),
]


def stage_content(stage):
    return deepcopy(STAGES[stage])


def available_materials(stage, unlocked, reveal=False):
    return [deepcopy(m) for m in MATERIALS if m['stage'] <= min(stage, unlocked)
            and (not m.get('gated') or reveal)]


def scenario(treatment, variant):
    """Purely hypothetical qualitative outcomes; never empirical simulation."""
    labels = {
        'remove_tip': ['去顶后仍伸长，但未向光弯曲', '去顶后仍伸长，并向光弯曲', '去顶后未出现明显伸长，也未弯曲'],
        'tip_shade': ['顶端遮光后仍伸长，但未向光弯曲', '顶端遮光后仍伸长，并向光弯曲', '顶端遮光后生长很弱，弯曲难以判断'],
        'lower_shade': ['下部遮光后仍伸长，并向光弯曲', '下部遮光后仍伸长，但未向光弯曲', '下部遮光后生长很弱，弯曲难以判断'],
        'marking': ['下部一段标记间距两侧变化不同，出现弯曲', '上部一段标记间距两侧变化不同，出现弯曲', '标记模糊，无法可靠比较两侧间距变化'],
    }
    return dict(treatment=treatment, treatment_label=TREATMENTS[treatment], variant=variant,
                label=labels[treatment][variant], kind='假设情境／预期结果',
                control='对照：其余条件相同，完整植株接受单侧蓝光，出现伸长与向光弯曲。',
                boundary='这是供推理练习使用的预设情境，不是菜豆的真实实验数据。请说明结论成立的条件。')
