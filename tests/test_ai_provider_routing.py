"""Fast provider routing must preserve schema enforcement and API compatibility."""
import asyncio
import json

import httpx
import pytest
from fastapi import HTTPException

from test_app import env


@pytest.mark.parametrize('base,sort,structured,expected', [
    ('https://openrouter.ai/api/v1', 'throughput', True, {'sort': 'throughput', 'require_parameters': True}),
    ('https://openrouter.ai/api/v1', 'throughput', False, {'sort': 'throughput'}),
    ('https://openrouter.ai/api/v1', '', True, {'require_parameters': True}),
    ('https://openrouter.ai/api/v1', '', False, None),
    ('https://api.example.test/v1', 'throughput', True, None),
    ('https://api.example.test/v1', 'throughput', False, None),
])
def test_provider_routing_preserves_model_reasoning_and_schema(env, monkeypatch, base, sort, structured, expected):
    module, _ = env
    for key, value in {'AI_API_KEY': 'test-key', 'AI_MODEL': 'bytedance-seed/seed-2.0-lite',
                       'AI_REASONING_EFFORT': 'low', 'AI_MAX_TOKENS': '8192',
                       'AI_BASE_URL': base, 'AI_PROVIDER_SORT': sort}.items():
        monkeypatch.setenv(key, value)
    schema = {'type': 'object', 'properties': {}, 'additionalProperties': False}
    real_client = httpx.AsyncClient

    def handler(request):
        payload = json.loads(request.content)
        assert payload.get('provider') == expected
        assert payload['model'] == 'bytedance-seed/seed-2.0-lite'
        assert payload['reasoning'] == {'effort': 'low'}
        assert payload['max_tokens'] == 8192
        if structured:
            assert payload['response_format']['json_schema']['strict'] is True
            assert payload['response_format']['json_schema']['schema'] == schema
        else:
            assert 'response_format' not in payload
        return httpx.Response(200, json={'choices': [{'message': {'content': '{}'}}]})

    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    assert asyncio.run(module.call_ai([{'role': 'user', 'content': 'test'}],
        response_schema=schema if structured else None)) == '{}'


def test_invalid_provider_sort_fails_before_request(env, monkeypatch):
    module, _ = env
    monkeypatch.setenv('AI_API_KEY', 'test-key')
    monkeypatch.setenv('AI_MODEL', 'test-model')
    monkeypatch.setenv('AI_BASE_URL', 'https://openrouter.ai/api/v1')
    monkeypatch.setenv('AI_PROVIDER_SORT', 'invalid')
    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: pytest.fail('Must validate before network request'))
    with pytest.raises(HTTPException) as error:
        asyncio.run(module.call_ai([{'role': 'user', 'content': 'test'}]))
    assert error.value.status_code == 503
