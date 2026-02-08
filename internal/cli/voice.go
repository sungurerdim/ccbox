package cli

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/sungur/ccbox/internal/log"
	"github.com/sungur/ccbox/internal/voice"
)

var voiceCmd = &cobra.Command{
	Use:   "voice",
	Short: "Record voice and transcribe with whisper.cpp",
	Long:  "Records audio from the default microphone and transcribes using whisper.cpp. Output is printed to stdout for piping.",
	RunE: func(cmd *cobra.Command, args []string) error {
		model, _ := cmd.Flags().GetString("model")
		duration, _ := cmd.Flags().GetInt("duration")

		opts := voice.Options{
			Model:    model,
			Duration: duration,
		}

		log.Dim(fmt.Sprintf("Recording for %d seconds (press Ctrl+C to stop early)...", duration))

		text, err := voice.Pipeline(opts)
		if err != nil {
			return fmt.Errorf("voice transcription failed: %w", err)
		}

		if text == "" {
			log.Warn("No speech detected")
			return nil
		}

		// Output transcribed text to stdout for piping to other commands.
		fmt.Print(text)
		return nil
	},
}

func init() {
	voiceCmd.Flags().StringP("model", "m", "base.en", "Whisper model name (base.en, small, medium, large)")
	voiceCmd.Flags().IntP("duration", "d", 10, "Recording duration in seconds")
}
