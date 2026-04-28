#!/usr/bin/env python3
"""
Emit one profile + recent posts as JSON (Instagram-shaped nodes) for the Node scraper / live API.
Requires: pip install instaloader

Auth (pick one):
  INSTALOADER_SESSION_FILE + INSTALOADER_SESSION_USER  (recommended)
  INSTALOADER_USER + INSTALOADER_PASSWORD (or INSTALOADER_PASS)

Optional:
  INSTALOADER_VERBOSE=1  — print Instaloader retry / login-check lines to stderr (default: stderr quiet for one-line JSON on stdout).

Usage: python instaloader_profile.py USERNAME [MAX_POSTS]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _silence_instaloader_context_errors(L) -> None:
    """Instaloader logs GraphQL retries via context.error() to stderr even when quiet=True."""
    if _env_truthy("INSTALOADER_VERBOSE"):
        return
    ctx = L.context

    def quiet_error(msg: str, repeat_at_end: bool = True) -> None:
        if repeat_at_end:
            ctx.error_log.append(msg)

    ctx.error = quiet_error  # type: ignore[method-assign]


def post_to_api_node(post) -> dict:
    """Map Instaloader.Post to the structure Node parsePost() expects."""
    caption = post.caption or ""
    ts = int(post.date_utc.timestamp())
    likes = post.likes if post.likes is not None else 0
    comments = post.comments if post.comments is not None else 0
    views = int(getattr(post, "video_view_count", 0) or 0)
    # Reels / videos with play counts
    product_type = "clips" if post.typename == "GraphVideo" and views > 0 else "feed"
    return {
        "code": post.shortcode,
        "caption": {"text": caption},
        "like_count": likes,
        "comment_count": comments,
        "taken_at": ts,
        "view_count": views,
        "play_count": views,
        "product_type": product_type,
        "media_type": 2 if post.is_video else 1,
        "is_paid_partnership": bool(getattr(post, "is_paid_partnership", False)),
        "usertags": {"in": []},
        "sponsor_tags": [],
        "coauthor_producers": [],
        "carousel_media_count": None,
        "image_versions2": {"candidates": [{"url": post.url}]},
    }


def profile_dict(profile) -> dict:
    following = 0
    try:
        fm = profile._full_metadata  # type: ignore[attr-defined]
        if isinstance(fm, dict):
            edge = fm.get("edge_follow")
            if isinstance(edge, dict):
                following = int(edge.get("count") or 0)
    except (AttributeError, TypeError, KeyError):
        pass
    return {
        "username": profile.username,
        "pk": str(profile.userid),
        "full_name": profile.full_name or "",
        "followers": profile.followers,
        "following": following,
        "posts_count": profile.mediacount,
        "bio": profile.biography or "",
        "category": getattr(profile, "business_category_name", None) or "",
        "external_url": profile.external_url or "",
        "profile_pic": profile.profile_pic_url or "",
        "is_verified": bool(profile.is_verified),
        "is_private": bool(profile.is_private),
    }


def main() -> int:
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "usage: instaloader_profile.py USERNAME [MAX_POSTS]"})
        return 2
    username = sys.argv[1].strip().lstrip("@")
    max_posts = int(sys.argv[2]) if len(sys.argv) > 2 else 50

    try:
        import instaloader
    except ImportError:
        emit({"ok": False, "error": "instaloader not installed (pip install instaloader)"})
        return 3

    L = instaloader.Instaloader(
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        quiet=True,
    )
    _silence_instaloader_context_errors(L)

    session_file = (os.environ.get("INSTALOADER_SESSION_FILE") or "").strip()
    session_user = (os.environ.get("INSTALOADER_SESSION_USER") or os.environ.get("INSTALOADER_USER") or "").strip()
    login_user = (os.environ.get("INSTALOADER_USER") or "").strip()
    login_pass = (os.environ.get("INSTALOADER_PASSWORD") or os.environ.get("INSTALOADER_PASS") or "").strip()

    authed = False
    try:
        if session_file:
            p = Path(session_file)
            if not p.is_file():
                emit(
                    {
                        "ok": False,
                        "error": f"INSTALOADER_SESSION_FILE not found: {p}. "
                        "Run: python -m instaloader --login YOUR_USERNAME (creates %LOCALAPPDATA%\\Instaloader\\session-YOUR_USERNAME on Windows).",
                    }
                )
                return 4
            authed = True
            L.load_session_from_file(session_user or login_user or username, str(p))
        elif login_user and login_pass:
            authed = True
            L.login(login_user, login_pass)
    except Exception as e:
        emit({"ok": False, "error": f"login/session: {e!s}"})
        return 4

    # test_login() hits Instagram's "who am I" check and often fails (rate limit / checkpoint) while
    # Profile.from_username for *public* profiles can still work. Set INSTALOADER_SKIP_TEST_LOGIN=1
    # in .env to skip and try the fetch anyway (default: require a passing check when authed).
    if authed and not _env_truthy("INSTALOADER_SKIP_TEST_LOGIN"):
        who = L.test_login()
        if not who:
            emit(
                {
                    "ok": False,
                    "error": (
                        "Instagram session check failed (rate limit, checkpoint, or stale cookies). "
                        "Wait several minutes, pause other scrapers, then run "
                        "`python -m instaloader --login YOUR_USER` again or finish any IG app security prompt. "
                        "If you are sure the session is fine, set INSTALOADER_SKIP_TEST_LOGIN=1 in scraper/.env (skips this check; public profiles may still work)."
                    ),
                }
            )
            return 5

    try:
        profile = instaloader.Profile.from_username(L.context, username)
    except instaloader.exceptions.ProfileNotExistsException:
        emit(
            {
                "ok": False,
                "error": (
                    f"Profile {username!r} not found, or Instagram blocked the lookup "
                    f"(same Instaloader exception for both). If the handle is public and spelled correctly, "
                    f"retry after a cooldown or refresh the session."
                ),
            }
        )
        return 5
    except Exception as e:
        emit({"ok": False, "error": str(e)})
        return 5

    prof = profile_dict(profile)
    items: list = []
    try:
        for i, post in enumerate(profile.get_posts()):
            if i >= max_posts:
                break
            items.append(post_to_api_node(post))
    except Exception as e:
        emit({"ok": False, "error": f"posts: {e!s}", "profile": prof, "items": items})
        return 6

    emit({"ok": True, "profile": prof, "items": items})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
