"""The provider-neutral tool-calling chat in app/llm.py, against fake SDK clients."""

from contextlib import contextmanager
from types import SimpleNamespace as NS

import pytest

import app.llm as llm
from app.config import Provider

OPENAI = Provider("o", "openai", "m", "https://x", api_key="sk-test")
CLAUDE = Provider("c", "claude", "claude-x", "https://y", api_key="sk-test")
TOOLS = [{"name": "read_file", "description": "Read", "parameters": {"type": "object", "properties": {}}}]
MSGS = [
    {"role": "user", "content": "fix it"},
    {"role": "assistant", "content": "Looking.", "tool_calls": [{"id": "t1", "name": "read_file", "arguments": {"path": "a.tex"}}]},
    {"role": "tool", "tool_call_id": "t1", "name": "read_file", "content": "1| hi"},
    {"role": "tool", "tool_call_id": "t2", "name": "search", "content": "none"},
]


def test_openai_message_and_tool_shapes():
    out = llm.to_openai_messages("SYS", MSGS)
    assert out[0] == {"role": "system", "content": "SYS"}
    assert out[2]["tool_calls"][0] == {"id": "t1", "type": "function",
                                        "function": {"name": "read_file", "arguments": '{"path": "a.tex"}'}}
    assert out[3] == {"role": "tool", "tool_call_id": "t1", "content": "1| hi"}
    assert llm.to_openai_tools(TOOLS)[0]["function"]["name"] == "read_file"


def test_anthropic_message_shapes_merge_tool_results():
    out = llm.to_anthropic_messages(MSGS)
    assert [m["role"] for m in out] == ["user", "assistant", "user"]
    assert out[1]["content"][1] == {"type": "tool_use", "id": "t1", "name": "read_file", "input": {"path": "a.tex"}}
    assert [b["tool_use_id"] for b in out[2]["content"]] == ["t1", "t2"]   # one user turn, two results
    assert llm.to_anthropic_tools(TOOLS)[0]["input_schema"]["type"] == "object"


def _chunk(content=None, tool_calls=None, finish=None, reasoning=None, usage=None):
    delta = NS(content=content, tool_calls=tool_calls, reasoning_content=reasoning)
    return NS(choices=[NS(delta=delta, finish_reason=finish)], usage=usage)


def _tc(index, id=None, name=None, args=None):
    return NS(index=index, id=id, function=NS(name=name, arguments=args))


class FakeOpenAI:
    def __init__(self, chunks, reject_stream_options=False):
        self.calls = []
        outer = self

        class Completions:
            def create(self, **kw):
                outer.calls.append(kw)
                if reject_stream_options and "stream_options" in kw:
                    raise Exception("unknown field stream_options")
                return iter(chunks)

        self.chat = NS(completions=Completions())


def test_openai_stream_text_reasoning_tool_calls_usage(monkeypatch):
    chunks = [
        _chunk(reasoning="thinking…"),
        _chunk(content="Let me "), _chunk(content="look."),
        _chunk(tool_calls=[_tc(0, "call_a", "read_", '{"pa')]),
        _chunk(tool_calls=[_tc(0, None, "file", 'th": "a.tex"}')]),
        _chunk(tool_calls=[_tc(1, "call_b", "search", "not json")]),
        _chunk(finish="tool_calls"),
        NS(choices=[], usage=NS(prompt_tokens=11, completion_tokens=7)),
    ]
    fake = FakeOpenAI(chunks, reject_stream_options=True)
    monkeypatch.setattr(llm, "_openai_client", lambda p: fake)
    evs = list(llm.chat(OPENAI, "m", "SYS", [{"role": "user", "content": "hi"}], tools=TOOLS))
    kinds = [e["type"] for e in evs]
    assert kinds == ["reasoning", "text", "text", "usage", "tool_call", "tool_call", "done"]
    assert evs[4] == {"type": "tool_call", "id": "call_a", "name": "read_file", "arguments": {"path": "a.tex"}}
    assert evs[5]["arguments"] == {"_raw": "not json"}
    assert evs[3] == {"type": "usage", "input": 11, "output": 7}
    assert evs[-1]["stop"] == "tool_calls"
    assert len(fake.calls) == 2 and "stream_options" not in fake.calls[1]      # retried without it
    assert fake.calls[1]["tools"][0]["type"] == "function"


def test_tools_dropped_when_provider_disables_them(monkeypatch):
    fake = FakeOpenAI([_chunk(content="hi"), _chunk(finish="stop")])
    monkeypatch.setattr(llm, "_openai_client", lambda p: fake)
    p = Provider("o", "openai", "m", "", api_key="k", tools=False)
    list(llm.chat(p, "m", "", [{"role": "user", "content": "x"}], tools=TOOLS))
    assert "tools" not in fake.calls[0]


def test_errors_become_llmerror_and_flag_tool_support(monkeypatch):
    class Boom:
        chat = NS(completions=NS(create=lambda **kw: (_ for _ in ()).throw(Exception("this model does not support tools"))))

    monkeypatch.setattr(llm, "_openai_client", lambda p: Boom())
    with pytest.raises(llm.LLMError) as e:
        list(llm.chat(OPENAI, "m", "", [{"role": "user", "content": "x"}], tools=TOOLS))
    assert e.value.tools_unsupported
    with pytest.raises(llm.LLMError):
        list(llm.chat(Provider("n", "openai", "m", "", api_key=None), "m", "", []))
    with pytest.raises(llm.LLMError):
        list(llm.chat(OPENAI, "", "", []))                  # no model


def test_claude_stream(monkeypatch):
    events = [NS(type="message_start"),
              NS(type="content_block_delta", delta=NS(type="thinking_delta", thinking="hmm")),
              NS(type="content_block_delta", delta=NS(type="text_delta", text="Reading.")),
              NS(type="content_block_stop")]
    final = NS(content=[NS(type="text", text="Reading."),
                        NS(type="tool_use", id="tu1", name="read_file", input={"path": "a.tex"})],
               usage=NS(input_tokens=5, output_tokens=3), stop_reason="tool_use")
    seen = {}

    class Stream:
        def __iter__(self):
            return iter(events)

        def get_final_message(self):
            return final

    @contextmanager
    def stream(**kw):
        seen.update(kw)
        yield Stream()

    monkeypatch.setattr(llm, "_claude_client", lambda p: NS(messages=NS(stream=stream)))
    evs = list(llm.chat(CLAUDE, "claude-x", "SYS", MSGS, tools=TOOLS))
    assert [e["type"] for e in evs] == ["reasoning", "text", "tool_call", "usage", "done"]
    assert evs[2]["arguments"] == {"path": "a.tex"} and evs[-1]["stop"] == "tool_use"
    assert seen["system"] == "SYS" and seen["tools"][0]["name"] == "read_file"


def test_complete_and_stream_keep_working(monkeypatch):
    fake = FakeOpenAI([_chunk(content=" Hello "), _chunk(content="world "), _chunk(finish="stop")])
    monkeypatch.setattr(llm, "_openai_client", lambda p: fake)
    assert llm.complete(OPENAI, "s", "u") == "Hello world"
    assert fake.calls[0]["model"] == "m"
    fake2 = FakeOpenAI([_chunk(content="a"), _chunk(content="b")])
    monkeypatch.setattr(llm, "_openai_client", lambda p: fake2)
    assert list(llm.stream(OPENAI, "s", "u", model="other")) == ["a", "b"]
    assert fake2.calls[0]["model"] == "other"


def test_list_models(monkeypatch):
    page = NS(data=[NS(id="b"), NS(id="a"), NS(id="a")])
    monkeypatch.setattr(llm, "_openai_client", lambda p: NS(models=NS(list=lambda: page)))
    assert llm.list_models(OPENAI) == ["a", "b"]
