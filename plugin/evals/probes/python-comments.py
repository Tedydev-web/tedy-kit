import re
import sys
import tokenize

DIRECTIVE = re.compile(r"#\s*(noqa\b|type:|pragma\b|fmt:|pylint:|ruff:|mypy:)")
COOKIE = re.compile(r"#.*coding[:=]")


def comments(path):
    found = []
    with open(path, "rb") as handle:
        for token in tokenize.tokenize(handle.readline):
            if token.type != tokenize.COMMENT:
                continue
            line, text = token.start[0], token.string
            if line == 1 and text.startswith("#!"):
                continue
            if line <= 2 and COOKIE.match(text):
                continue
            if DIRECTIVE.match(text):
                continue
            found.append(f"{path}:{line}: {text.strip()}")
    return found


def main(paths):
    for path in paths:
        for line in comments(path):
            print(line)


if __name__ == "__main__":
    main(sys.argv[1:])
