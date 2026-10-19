import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "study"))

from study_sweep_record import write_record
from study_topic import TopicError, topic_for_sweep

if len(sys.argv) != 3:
    sys.exit("usage: prior-art-sweep-record.py <repo> <sweep>")
try:
    print(write_record(sys.argv[1], topic_for_sweep(sys.argv[1], sys.argv[2])))
except TopicError as error:
    sys.exit(f"prior-art-sweep-record: {error}")
