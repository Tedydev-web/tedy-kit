import re

from study_calibration_set import README_CUES, cue_lines

FACT_CUE = re.compile(r"fact:((?:prefilled|evidence)\.[A-Za-z0-9_]+)")
README_CUE_NAMES = {f"{group}:{word}": word for group, words in README_CUES for word in words}
MISSING = object()


def field(row, dotted):
    value = row
    for part in dotted.split("."):
        if not isinstance(value, dict) or part not in value:
            return MISSING
        value = value[part]
    return value


def valid_cue(cue):
    return isinstance(cue, str) and (cue in README_CUE_NAMES or FACT_CUE.fullmatch(cue) is not None)


def cue_selects(cue, row):
    if cue in README_CUE_NAMES:
        return bool(cue_lines(row.get("readme"), (README_CUE_NAMES[cue],)))
    return field(row, cue[5:]) not in (MISSING, None, False, "", [], {})
