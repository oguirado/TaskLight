"""U55 public planning interfaces (fail-first stubs)."""
from .errors import PlanError
from .template import canonical_template_json, template_hash, validate_template, load_template, resolve_template
from .ops import validate_op_shape, is_valid_op_shape
from .fold import empty_projection, apply_op_event, fold_plan
from .conformance import check_conformance
from .markdown import render_plan_md, render_memory_md
