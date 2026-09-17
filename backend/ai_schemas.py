"""Schemas for classroom responses that the application must parse."""


def object_schema(properties):
    return {'type': 'object', 'properties': properties,
            'required': list(properties), 'additionalProperties': False}


GUIDANCE_SCHEMA = object_schema({
    'text': {'type': 'string'},
    'step': {'type': 'integer', 'minimum': 1, 'maximum': 4},
    'mastery': {'type': 'string'},
})

EXTRACTION_SCHEMA = object_schema({
    'sense': {'type': 'string'},
    'substance': {'type': 'string'},
    'elongation': {'type': 'string'},
    'uncertain': {'type': 'array', 'items': {'type': 'string', 'enum': ['sense', 'substance', 'elongation']}},
})


def grading_schema(rubric, sources):
    return object_schema({'items': {
        'type': 'array', 'minItems': len(rubric), 'maxItems': len(rubric),
        'items': object_schema({
            'key': {'type': 'string', 'enum': [r[0] for r in rubric]},
            'points': {'type': 'integer', 'minimum': 0, 'maximum': max(r[2] for r in rubric)},
            'missing': {'type': 'boolean'},
            'evidence': {'type': 'array', 'items': {'type': 'string', 'enum': sorted(sources)}},
            'reason': {'type': 'string'},
        }),
    }})
