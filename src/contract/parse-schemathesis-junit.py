#!/usr/bin/env python3
"""
parse-schemathesis-junit.py

Parses JUnit XML output from Schemathesis contract tests and produces
a normalized contract-summary.json for reporting and Allure test suites.
"""

import argparse
import json
import os
import sys
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description="Parse Schemathesis JUnit XML into JSON summary")
parser.add_argument("--in", dest="infile", required=True, help="Input JUnit XML file path")
parser.add_argument("--out", dest="outfile", required=True, help="Output JSON file path")
args = parser.parse_args()

if not os.path.exists(args.infile):
    print(f"[parse-schemathesis] Input file not found: {args.infile}", file=sys.stderr)
    sys.exit(1)

try:
    tree = ET.parse(args.infile)
    root = tree.getroot()
except Exception as e:
    print(f"[parse-schemathesis] XML parse error: {e}", file=sys.stderr)
    sys.exit(1)

testcases = root.findall(".//testcase")
total = len(testcases)
failures = []

for tc in testcases:
    fail_node = tc.find("failure")
    error_node = tc.find("error")
    node = fail_node if fail_node is not None else error_node
    if node is not None:
        endpoint = (tc.get("classname", "") + " " + tc.get("name", "")).strip()
        reason = (node.get("message") or node.text or "Schema validation failed").strip().splitlines()[0]
        failures.append({
            "endpoint": endpoint,
            "reason": reason
        })

failed = len(failures)
passed = total - failed

summary = {
    "total": total,
    "passed": passed,
    "failed": failed,
    "failures": failures
}

os.makedirs(os.path.dirname(os.path.abspath(args.outfile)), exist_ok=True)
with open(args.outfile, "w", encoding="utf-8") as f:
    json.dump(summary, f, indent=2)

print(f"[parse-schemathesis] Parsed {total} check(s): {passed} passed, {failed} failed -> {args.outfile}")
