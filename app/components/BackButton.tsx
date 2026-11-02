// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useNavigate } from "react-router";

/** Returns to the previous page, or to the home page when this page was opened directly. */
export function BackButton() {
	const navigate = useNavigate();
	// React Router stores its position in history as idx. At 0, going back would leave the app.
	const goBack = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/"));

	return (
		<Tooltip content="Back" side="bottom" asChild>
			<Button variant="ghost" shape="square" size="sm" icon={<ArrowLeftIcon size={18} />} onClick={goBack} aria-label="Back" />
		</Tooltip>
	);
}
