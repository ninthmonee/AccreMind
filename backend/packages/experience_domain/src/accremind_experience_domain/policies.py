from accremind_contracts import ExperienceMaturity, Scope

from .errors import DomainRuleViolation, ScopeViolation


def constrain_scope(authenticated: Scope, requested: Scope | None) -> Scope:
    """Return an allowed requested scope; never widen authenticated authority."""

    if requested is None:
        return authenticated
    if authenticated.organization_id != requested.organization_id:
        raise ScopeViolation("requested organization is outside token scope")

    if authenticated.personal_owner_id is not None:
        if requested != authenticated:
            raise ScopeViolation("personal token cannot request another scope")
        return requested

    if requested.personal_owner_id is not None:
        raise ScopeViolation("organization/team/project token cannot enter personal scope")

    if authenticated.team_id is not None and authenticated.team_id != requested.team_id:
        raise ScopeViolation("requested team is outside token scope")
    if authenticated.project_id is not None and authenticated.project_id != requested.project_id:
        raise ScopeViolation("requested project is outside token scope")

    return requested


def promote_maturity(
    current: ExperienceMaturity,
    *,
    has_validation: bool,
    independent_helpful_uses: int,
    proven_threshold: int = 2,
) -> ExperienceMaturity:
    if current == ExperienceMaturity.DRAFT:
        if not has_validation:
            raise DomainRuleViolation("verified maturity requires validation evidence")
        return ExperienceMaturity.VERIFIED
    if current == ExperienceMaturity.VERIFIED:
        if independent_helpful_uses < proven_threshold:
            raise DomainRuleViolation("proven maturity requires independent helpful uses")
        return ExperienceMaturity.PROVEN
    raise DomainRuleViolation("proven maturity cannot be promoted further")
