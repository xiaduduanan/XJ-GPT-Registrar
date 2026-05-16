# -*- coding: utf-8 -*-
"""
Custom mailbox API settings.

This integration only creates an address and fills it into the Web GUI manual
email list. OTP reading stays manual in the page.
"""

# Example: "https://xxxx.xxxx"
MAIL_API_BASE = "https://temp-email.xduduanan.workers.dev"

# Admin password used by /admin/new_address.
ADMIN_AUTH = "123"

# Optional private site password, if your worker enabled it.
CUSTOM_AUTH = ""

# Domain to create addresses under, for example "example.com".
MAIL_DOMAIN = "617901.xyz"

# Whether the API should enable prefix mode.
ENABLE_PREFIX = True
