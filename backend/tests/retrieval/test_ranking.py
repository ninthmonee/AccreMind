from accremind_retriever_agent import metrics, normalize_technology, rrf, terms


def test_rrf_rewards_agreement_without_duplicate_votes():
    scores = rrf([["a", "b", "a"], ["b", "c"]])
    assert max(scores, key=scores.get) == "b"
    assert scores["a"] == 1 / 61


def test_aliases_and_chinese_queries():
    assert normalize_technology("ReactJS") == "react"
    assert "分页" in terms("分页请求竞态")
    assert "typescript" in terms("TS")


def test_metrics_count_only_top_k():
    assert metrics({"a", "c"}, ["b", "a", "c"], k=2) == {"recall_at_k": 0.5, "reciprocal_rank": 0.5}
