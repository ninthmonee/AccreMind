class DomainRuleViolation(ValueError):
    """A domain invariant was violated."""


class InvalidTransition(DomainRuleViolation):
    pass


class ScopeViolation(DomainRuleViolation):
    pass
