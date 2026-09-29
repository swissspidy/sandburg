<?php
/**
 * Plugin Name: Reading Time
 * Description: Shows an estimated reading time above each post, with a configurable reading speed.
 * Version: 1.0.0
 * Requires at least: 6.4
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 * Text Domain: reading-time
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const READING_TIME_OPTION = 'reading_time_wpm';

function reading_time_minutes( $content ) {
	$wpm   = max( 1, (int) get_option( READING_TIME_OPTION, 200 ) );
	$words = str_word_count( wp_strip_all_tags( $content ) );
	return max( 1, (int) ceil( $words / $wpm ) );
}

add_filter(
	'the_content',
	function ( $content ) {
		if ( ! is_singular( 'post' ) || ! in_the_loop() || ! is_main_query() ) {
			return $content;
		}
		$minutes = reading_time_minutes( $content );
		/* translators: %d: minutes */
		$label = sprintf( _n( '%d min read', '%d min read', $minutes, 'reading-time' ), $minutes );
		return '<p class="reading-time" data-reading-time="' . esc_attr( $minutes ) . '">' . esc_html( $label ) . '</p>' . $content;
	}
);

add_action(
	'admin_init',
	function () {
		register_setting(
			'reading_time',
			READING_TIME_OPTION,
			array(
				'type'              => 'integer',
				'sanitize_callback' => 'absint',
				'default'           => 200,
			)
		);
		add_settings_section( 'reading_time_main', __( 'Reading speed', 'reading-time' ), '__return_false', 'reading-time' );
		add_settings_field(
			READING_TIME_OPTION,
			__( 'Words per minute', 'reading-time' ),
			function () {
				printf(
					'<input type="number" min="1" id="%1$s" name="%1$s" value="%2$d" />',
					esc_attr( READING_TIME_OPTION ),
					(int) get_option( READING_TIME_OPTION, 200 )
				);
			},
			'reading-time',
			'reading_time_main',
			array( 'label_for' => READING_TIME_OPTION )
		);
	}
);

add_action(
	'admin_menu',
	function () {
		add_options_page(
			__( 'Reading Time', 'reading-time' ),
			__( 'Reading Time', 'reading-time' ),
			'manage_options',
			'reading-time',
			function () {
				?>
				<div class="wrap">
					<h1><?php esc_html_e( 'Reading Time', 'reading-time' ); ?></h1>
					<form method="post" action="options.php">
						<?php
						settings_fields( 'reading_time' );
						do_settings_sections( 'reading-time' );
						submit_button();
						?>
					</form>
				</div>
				<?php
			}
		);
	}
);
