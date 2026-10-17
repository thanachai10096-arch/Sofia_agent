from benchmarks.benchmark_memory import is_allowed_service_url


def test_service_url_requires_https_except_exact_loopback_hosts() -> None:
    assert is_allowed_service_url("https://ai.example/v1")
    assert is_allowed_service_url("http://localhost:8000")
    assert is_allowed_service_url("http://127.0.0.1:8000")
    assert is_allowed_service_url("http://[::1]:8000")

    assert not is_allowed_service_url("http://ai.example")
    assert not is_allowed_service_url("http://localhost.attacker.example")
    assert not is_allowed_service_url("http://127.0.0.1.attacker.example")
    assert not is_allowed_service_url("http://localhost:invalid")
    assert not is_allowed_service_url("https:///missing-host")
    assert not is_allowed_service_url("https://user:secret@ai.example")
