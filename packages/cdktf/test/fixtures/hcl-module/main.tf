# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

resource "aws_vpc" "example" {
  cidr_block = "10.1.0.0/16"
}