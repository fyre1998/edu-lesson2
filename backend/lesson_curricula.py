"""Select frozen lesson definitions for live classes and persisted jobs."""
from . import lesson_v2, lesson_v3, lesson_grape, lesson_grape_v5

INQUIRY_FLOWS = (3, 4, 5)
GRAPE_FLOWS = (4, 5)
CURRICULA = {2: lesson_v2, 3: lesson_v3, 4: lesson_grape, 5: lesson_grape_v5}
MATCH_CURRICULA = {c.MATCH_VERSION: c for c in (lesson_v3, lesson_grape, lesson_grape_v5)}


def curriculum(flow_version):
    return CURRICULA[flow_version]


def matching_curriculum(mapping_version):
    # Historical v3 mappings also included the original Went task.
    return MATCH_CURRICULA.get(mapping_version, lesson_v3)
