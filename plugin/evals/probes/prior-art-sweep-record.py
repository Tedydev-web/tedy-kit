import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "study"))

from study_sweep_record import render, write_record
from study_topic import TopicError, topic_for_sweep

if len(sys.argv) not in (3, 4) or sys.argv[3:] not in ([], ["--stdout"]):
    sys.exit("usage: prior-art-sweep-record.py <repo> <sweep> [--stdout]")
try:
    topic = topic_for_sweep(sys.argv[1], sys.argv[2])
    if sys.argv[3:]:
        sys.stdout.buffer.write(render(sys.argv[1], topic)[0].encode())
    else:
        print(write_record(sys.argv[1], topic))
except TopicError as error:
    sys.exit(f"prior-art-sweep-record: {error}")
