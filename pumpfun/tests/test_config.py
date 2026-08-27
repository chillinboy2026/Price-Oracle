"""Configuration: validation, secrets, and environment precedence."""

from __future__ import annotations

import pytest
import yaml
from pydantic import ValidationError

from src.models import ENV_PREFIX, Config


def write(tmp_path, data) -> str:
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(data))
    return str(path)


def test_defaults_are_dry_run():
    assert Config().mode == "dry-run"
    assert not Config().is_live


def test_the_shipped_placeholder_does_not_start(tmp_path):
    path = write(tmp_path, {"grok": {"api_key": "xai-your-key-here"}})
    problems = Config.load(path, environ={}).problems()
    assert any("grok.api_key" in p for p in problems)


def test_live_without_a_wallet_key_is_an_error(tmp_path):
    path = write(tmp_path, {"mode": "live", "grok": {"api_key": "xai-real"}})
    assert any("wallet_private_key" in p for p in Config.load(path, environ={}).problems())


def test_a_single_trade_may_not_exceed_the_daily_limit(tmp_path):
    path = write(tmp_path, {
        "grok": {"api_key": "xai-real"},
        "risk": {"max_sol_per_trade": 1.0, "daily_loss_limit_sol": 0.5},
    })
    assert any("exceeds" in p for p in Config.load(path, environ={}).problems())


def test_a_valid_config_has_no_problems(tmp_path):
    path = write(tmp_path, {"grok": {"api_key": "xai-real"}, "data": {"api_key": "d"}})
    assert Config.load(path, environ={}).problems() == []


@pytest.mark.parametrize(
    "section",
    [
        {"risk": {"max_sol_per_trade": 0}},
        {"risk": {"max_trades_per_day": 0}},
        {"risk": {"max_open_positions": 0}},
        {"filter": {"min_total_score": 1.5}},
        {"solana": {"slippage_bps": 20000}},
        {"logging": {"level": "CHATTY"}},
        {"mode": "yolo"},
    ],
)
def test_out_of_range_values_are_rejected(section):
    with pytest.raises(ValidationError):
        Config.model_validate(section)


def test_unknown_keys_are_rejected_rather_than_ignored():
    """A typo'd limit that is silently ignored is a disabled limit."""
    with pytest.raises(ValidationError):
        Config.model_validate({"risk": {"max_sol_per_trad": 0.1}})


def test_warnings_are_advisory_not_blocking(tmp_path):
    path = write(tmp_path, {
        "grok": {"api_key": "xai-real"},
        "filter": {"min_total_score": 0.1},
    })
    config = Config.load(path, environ={})
    assert config.problems() == []
    assert any("min_total_score" in w for w in config.warnings())


def test_live_without_simulation_warns(tmp_path):
    config = Config.model_validate({
        "mode": "live",
        "grok": {"api_key": "x"},
        "solana": {"wallet_private_key": "k", "simulate_before_send": False},
    })
    assert any("simulate_before_send" in w for w in config.warnings())


# -- secrets ---------------------------------------------------------------


def test_secrets_are_absent_from_repr_and_dumps():
    config = Config.model_validate({"grok": {"api_key": "xai-super-secret"}})
    assert "xai-super-secret" not in repr(config)
    assert "xai-super-secret" not in str(config.model_dump())
    assert "xai-super-secret" not in str(config.masked())


def test_masking_distinguishes_set_from_unset():
    config = Config.model_validate({"grok": {"api_key": "xai-real"}})
    masked = config.masked()
    assert masked["grok"]["api_key"] == "***set***"
    assert masked["solana"]["wallet_private_key"] == "***unset***"


# -- environment -----------------------------------------------------------


def test_environment_overrides_the_file(tmp_path):
    path = write(tmp_path, {"mode": "dry-run", "grok": {"api_key": "from-file"}})
    config = Config.load(path, environ={ENV_PREFIX + "GROK_API_KEY": "from-env"})
    assert config.grok.api_key.get_secret_value() == "from-env"


def test_an_empty_variable_does_not_erase_a_file_value(tmp_path):
    """The classic compose mistake: an unset variable expands to empty."""
    path = write(tmp_path, {"grok": {"api_key": "from-file"}})
    config = Config.load(path, environ={ENV_PREFIX + "GROK_API_KEY": ""})
    assert config.grok.api_key.get_secret_value() == "from-file"


def test_environment_can_supply_a_nested_value_with_no_file_section(tmp_path):
    path = write(tmp_path, {"grok": {"api_key": "k"}})
    config = Config.load(path, environ={ENV_PREFIX + "RPC_URL": "https://rpc.invalid"})
    assert config.solana.rpc_url == "https://rpc.invalid"


def test_mode_can_be_switched_by_environment(tmp_path):
    path = write(tmp_path, {"grok": {"api_key": "k"}})
    assert Config.load(path, environ={ENV_PREFIX + "MODE": "live"}).is_live


def test_an_empty_config_file_is_valid(tmp_path):
    path = tmp_path / "empty.yaml"
    path.write_text("")
    assert Config.load(path, environ={}).mode == "dry-run"


def test_a_non_mapping_config_is_rejected(tmp_path):
    path = tmp_path / "list.yaml"
    path.write_text("- a\n- b\n")
    with pytest.raises(ValueError, match="must be a mapping"):
        Config.load(path, environ={})
