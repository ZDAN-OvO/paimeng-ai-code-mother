from langchain_openai import ChatOpenAI

from app.config import Settings


def build_responses_model(settings: Settings) -> ChatOpenAI:
    return ChatOpenAI(
        base_url=settings.model_base_url,
        model=settings.model_name,
        api_key=settings.model_api_key,
        use_responses_api=True,
        output_version="responses/v1",
        timeout=60,
        max_retries=0,
    )
