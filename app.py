import os, json, re
import streamlit as st
from pathlib import Path
from openai import OpenAI, OpenAIError

# --- Keys/Client ---
API_KEY = os.getenv("OPENAI_API_KEY")
client = OpenAI(api_key=API_KEY)

# --- Load products ---
DATA_PATH = Path(__file__).parent / "products.json"
with open(DATA_PATH, "r", encoding="utf-8") as f:
    products = json.load(f)

st.title("🛍️ AI-Powered Product Catalog (OpenAI)")
st.caption(f"API key loaded: {'YES' if API_KEY else 'NO'}")

query = st.text_input("🔍 Natural language search (e.g., 'running shoes under 100 with good reviews')")

SYSTEM_PROMPT = """You translate shopping queries into structured filters.
Return ONLY a valid JSON object with keys: category (string or null), max_price (number or null), min_rating (number or null).
Do not include backticks or extra text. If a field is missing, use null.
Categories in the catalog: Footwear, Electronics, Apparel.
Examples:
"cheap electronics with great reviews" -> {"category":"Electronics","max_price":null,"min_rating":4.0}
"footwear under 100" -> {"category":"Footwear","max_price":100,"min_rating":null}
"""

def get_filters_from_query_openai(q: str) -> dict:
    """Ask OpenAI to extract {category, max_price, min_rating} from free-text query."""
    try:
        resp = client.chat.completions.create(
            model="gpt-4o-mini",  # fast+cheap; adjust if needed
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": q},
            ],
            temperature=0,
            max_tokens=120,
        )
        content = resp.choices[0].message.content.strip()
        # Hard-guard: strip code fences if model adds them
        content = re.sub(r"^```(?:json)?|```$", "", content).strip()
        data = json.loads(content)
        # normalize keys
        return {
            "category": data.get("category"),
            "max_price": data.get("max_price"),
            "min_rating": data.get("min_rating"),
        }
    except json.JSONDecodeError:
        # fallback: very light heuristic if model returns text
        return {"category": None, "max_price": None, "min_rating": None}
    except OpenAIError as e:
        # Surface common issues nicely in UI
        st.error(f"OpenAI error: {getattr(e, 'message', str(e))}")
        return {"category": None, "max_price": None, "min_rating": None}
    except Exception as e:
        st.error(f"Unexpected error: {e}")
        return {"category": None, "max_price": None, "min_rating": None}

def filter_products(items, filters):
    out = []
    for p in items:
        if filters.get("category") and filters["category"].lower() not in p["category"].lower():
            continue
        if filters.get("max_price") is not None and isinstance(filters["max_price"], (int, float)):
            if p["price"] > filters["max_price"]:
                continue
        if filters.get("min_rating") is not None and isinstance(filters["min_rating"], (int, float)):
            if p["rating"] < float(filters["min_rating"]):
                continue
        out.append(p)
    return out

if query:
    with st.spinner("🧠 Asking OpenAI…"):
        filters = get_filters_from_query_openai(query)
    st.caption(f"Parsed filters → {filters}")
    results = filter_products(products, filters)
    st.subheader(f"Results ({len(results)})")
    for r in results:
        st.write(f"**{r['name']}** — ${r['price']} — {r['category']} — ⭐ {r['rating']}")
        st.caption(r["description"])
else:
    st.subheader("Full Catalog")
    for p in products:
        st.write(f"**{p['name']}** — ${p['price']} — {p['category']} — ⭐ {p['rating']}")
        st.caption(p["description"])
